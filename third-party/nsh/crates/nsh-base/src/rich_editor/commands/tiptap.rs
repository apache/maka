//! Tiptap's command catalog (`@tiptap/core`'s `commands/`), over the
//! kernel's commands: each keeps Tiptap's name (in snake case) and
//! semantics, and takes the types it works on as arguments, so it works
//! with any schema. Where Tiptap's commands share one transaction in a
//! chain, these compose with [`chain`](super::chain), which runs each on
//! the state the ones before leave and dispatches one transaction.
//!
//! The commands that share a name with `prosemirror-commands`' (`lift`,
//! `toggle_mark`, `set_mark`, `unset_mark`) are Tiptap's here; reach them
//! as `tiptap::toggle_mark` and so on.

use serde_json::Value;

use super::{
    BoxCommand, Dispatch,
    base::{self, send},
    chain, command,
    helpers::{
        ParentNode, can_join_items_at, find_parent_node, get_mark_attributes, get_mark_range,
        is_mark_active, is_node_active, selection_to_insertion_end,
    },
    list::{lift_list_item, wrap_in_list},
};
use crate::rich_editor::{
    model::{Attrs, Fragment, MarkType, Node, NodeType, ResolvedPos},
    state::{EditorState, NodeSelection, Selection, TextSelection, Transaction},
    transform::{MarkMatch, can_join, join_point, lift_target},
};

/// The meta key of transactions that ask the views showing the editor to
/// take the keyboard focus ([`focus`]); the session honors it.
pub const FOCUS_META: &str = "focus";

/// A command that applies and changes nothing.
pub fn noop() -> BoxCommand {
    command(|_, _| true)
}

// `extra` over `base` (Tiptap's `{ ...base, ...extra }`).
fn merged(base: Option<&Attrs>, extra: &Attrs) -> Attrs {
    let mut out = base.cloned().unwrap_or_default();
    out.extend(extra.iter().map(|(k, v)| (k.clone(), v.clone())));
    out
}

// The attributes of the anchor's parent when anchor and head share it.
fn attributes_to_copy(state: &EditorState) -> Option<Attrs> {
    let selection = state.selection();
    let anchor = selection.resolved_anchor();
    anchor
        .same_parent(selection.resolved_head())
        .then(|| anchor.parent().attrs().clone())
}

// Runs `f` on a fresh transaction and dispatches it when `f` applies.
fn with_tr(
    state: &EditorState,
    dispatch: Dispatch<'_>,
    f: impl FnOnce(&mut Transaction) -> bool,
) -> bool {
    let mut tr = state.tr();
    if !f(&mut tr) {
        return false;
    }
    if let Some(dispatch) = dispatch {
        dispatch(tr);
    }
    true
}

/// Turns the selected textblocks into `ty` (with `attrs` over those of the
/// selection's parent), clearing the nodes around them first when they
/// cannot be turned directly (out of a list item, say). Only textblock
/// types (Tiptap's `setNode`).
pub fn set_node(ty: NodeType, attrs: Attrs) -> BoxCommand {
    command(move |state, dispatch| {
        if !ty.is_textblock() {
            log::warn!("RichEditor: setNode only supports textblock types");
            return false;
        }
        let attrs = merged(attributes_to_copy(state).as_ref(), &attrs);
        let set = base::set_block_type(ty.clone(), Some(attrs));
        let prepare = if set(state, None) {
            noop()
        } else {
            clear_nodes()
        };
        chain(vec![prepare, set])(state, dispatch)
    })
}

/// Turns the selected textblocks into `ty` (with `attrs`), or into
/// `toggle_ty` when they are `ty` already (Tiptap's `toggleNode`).
pub fn toggle_node(ty: NodeType, toggle_ty: NodeType, attrs: Attrs) -> BoxCommand {
    command(move |state, dispatch| {
        let copy = attributes_to_copy(state);
        if is_node_active(state, Some(&ty), &attrs) {
            return set_node(toggle_ty.clone(), copy.unwrap_or_default())(state, dispatch);
        }
        set_node(ty.clone(), merged(copy.as_ref(), &attrs))(state, dispatch)
    })
}

/// Lifts the selected blocks out of their parent, when a node of `ty`
/// (with `attrs`) is active (Tiptap's `lift`).
pub fn lift(ty: NodeType, attrs: Attrs) -> BoxCommand {
    command(move |state, dispatch| {
        is_node_active(state, Some(&ty), &attrs) && base::lift(state, dispatch)
    })
}

/// Lifts the selection out of a node of `ty` (with `attrs`) when one is
/// active, else wraps it in one (Tiptap's `toggleWrap`).
pub fn toggle_wrap(ty: NodeType, attrs: Attrs) -> BoxCommand {
    command(move |state, dispatch| {
        if is_node_active(state, Some(&ty), &attrs) {
            return base::lift(state, dispatch);
        }
        base::wrap_in(ty.clone(), Some(attrs.clone()))(state, dispatch)
    })
}

/// Turns the selected blocks back into the default block (paragraphs) and
/// lifts them out of the nodes they are in, as far as they go (Tiptap's
/// `clearNodes`).
pub fn clear_nodes() -> BoxCommand {
    command(|state, dispatch| {
        with_tr(state, dispatch, |tr| {
            let doc = state.doc().clone();
            for range in state.selection().ranges() {
                doc.nodes_between(range.from.pos, range.to.pos, &mut |node, pos, _, _| {
                    if node.is_text() {
                        return true;
                    }
                    let (Ok(from), Ok(to)) = (
                        tr.doc().resolve(tr.mapping.map(pos, 1)),
                        tr.doc().resolve(tr.mapping.map(pos + node.node_size(), 1)),
                    ) else {
                        return true;
                    };
                    let Some(range) = from.block_range(&to, None) else {
                        return true;
                    };
                    let target = lift_target(&range);
                    if node.is_textblock()
                        && let Some(default) = from
                            .parent()
                            .content_match_at_lenient(from.index(from.depth))
                            .default_type()
                    {
                        let _ = tr.set_node_markup(range.start(), Some(default), None, None);
                    }
                    if let Some(target) = target {
                        let _ = tr.lift(&range, target);
                    }
                    true
                });
            }
            true
        })
    })
}

/// Removes every mark from the selection (Tiptap's `unsetAllMarks`).
pub fn unset_all_marks() -> BoxCommand {
    command(|state, dispatch| {
        if state.selection().empty() {
            return true;
        }
        with_tr(state, dispatch, |tr| {
            for range in state.selection().ranges() {
                for ty in state.schema().mark_types() {
                    let _ = tr.remove_mark(range.from.pos, range.to.pos, MarkMatch::Type(ty));
                }
            }
            true
        })
    })
}

/// Extends the selection over the text marked with `ty` (with `attrs`)
/// around its start, when that covers it (Tiptap's `extendMarkRange`).
pub fn extend_mark_range(ty: MarkType, attrs: Option<Attrs>) -> BoxCommand {
    command(move |state, dispatch| {
        with_tr(state, dispatch, |tr| {
            let selection = state.selection();
            if let Some((from, to)) = get_mark_range(selection.resolved_from(), &ty, attrs.as_ref())
                && from <= selection.from()
                && to >= selection.to()
            {
                tr.set_selection(TextSelection::create(state.doc(), from, Some(to)));
            }
            true
        })
    })
}

// Tiptap's `canSetMark`: whether a mark of `ty` can go on the selection.
fn can_set_mark(state: &EditorState, ty: &MarkType) -> bool {
    let selection = state.selection();
    if let Some(cursor) = selection.as_text().and_then(TextSelection::cursor) {
        let current = match state.stored_marks() {
            Some(marks) => marks.to_vec(),
            None => cursor.marks(),
        };
        return cursor.parent().ty().allows_mark_type(ty)
            && (ty.is_in_set(&current).is_some()
                || !current.iter().any(|mark| mark.ty().excludes(ty)));
    }
    selection.ranges().iter().any(|range| {
        let mut supports = range.from.depth == 0
            && state.doc().inline_content()
            && state.doc().ty().allows_mark_type(ty);
        state
            .doc()
            .nodes_between(range.from.pos, range.to.pos, &mut |node, _, parent, _| {
                if supports {
                    return false;
                }
                if node.is_inline() {
                    let parent_allows = parent.is_none_or(|p| p.ty().allows_mark_type(ty));
                    let marks_allow = ty.is_in_set(node.marks()).is_some()
                        || !node.marks().iter().any(|m| m.ty().excludes(ty));
                    supports = parent_allows && marks_allow;
                }
                !supports
            });
        supports
    })
}

/// Adds a mark of `ty` with `attrs` to the selection, merging them into
/// the attributes of marks of `ty` there already; at a cursor, into the
/// stored marks (Tiptap's `setMark`).
pub fn set_mark(ty: MarkType, attrs: Attrs) -> BoxCommand {
    command(move |state, dispatch| {
        if !can_set_mark(state, &ty) {
            return false;
        }
        with_tr(state, dispatch, |tr| {
            let selection = state.selection();
            if selection.empty() {
                let old = get_mark_attributes(state, &ty);
                match ty.create(Some(merged(Some(&old), &attrs))) {
                    Ok(mark) => {
                        tr.add_stored_mark(&mark);
                    }
                    Err(_) => return false,
                }
                return true;
            }
            for range in selection.ranges() {
                let (from, to) = (range.from.pos, range.to.pos);
                state.doc().nodes_between(from, to, &mut |node, pos, _, _| {
                    let trimmed_from = pos.max(from);
                    let trimmed_to = (pos + node.node_size()).min(to);
                    let existing: Vec<_> = node.marks().iter().filter(|m| m.ty() == &ty).collect();
                    if existing.is_empty() {
                        if let Ok(mark) = ty.create(Some(attrs.clone())) {
                            let _ = tr.add_mark(trimmed_from, trimmed_to, mark);
                        }
                    } else {
                        for mark in existing {
                            if let Ok(mark) = ty.create(Some(merged(Some(mark.attrs()), &attrs))) {
                                let _ = tr.add_mark(trimmed_from, trimmed_to, mark);
                            }
                        }
                    }
                    true
                });
            }
            true
        })
    })
}

/// Removes marks of `ty` from the selection and the stored marks; at a
/// cursor with `extend_empty_mark_range`, from the whole marked text around
/// it (Tiptap's `unsetMark`).
pub fn unset_mark(ty: MarkType, extend_empty_mark_range: bool) -> BoxCommand {
    command(move |state, dispatch| {
        with_tr(state, dispatch, |tr| {
            let selection = state.selection();
            if selection.empty() && extend_empty_mark_range {
                let (mut from, mut to) = (selection.from(), selection.to());
                let from_pos = selection.resolved_from();
                let attrs = from_pos
                    .marks()
                    .iter()
                    .find(|m| m.ty() == &ty)
                    .map(|m| m.attrs().clone());
                if let Some(range) = get_mark_range(from_pos, &ty, attrs.as_ref()) {
                    (from, to) = range;
                }
                let _ = tr.remove_mark(from, to, MarkMatch::Type(ty.clone()));
            } else {
                for range in selection.ranges() {
                    let _ =
                        tr.remove_mark(range.from.pos, range.to.pos, MarkMatch::Type(ty.clone()));
                }
            }
            tr.remove_stored_mark_type(&ty);
            true
        })
    })
}

/// Removes the mark `ty` when it is active with `attrs` (see
/// [`is_mark_active`]), else sets it with them (Tiptap's `toggleMark`).
pub fn toggle_mark(ty: MarkType, attrs: Attrs, extend_empty_mark_range: bool) -> BoxCommand {
    command(move |state, dispatch| {
        if is_mark_active(state, Some(&ty), &attrs) {
            unset_mark(ty.clone(), extend_empty_mark_range)(state, dispatch)
        } else {
            set_mark(ty.clone(), attrs.clone())(state, dispatch)
        }
    })
}

/// A node or mark type, as the commands that take either one name.
#[derive(Debug, Clone)]
pub enum SchemaType {
    /// A node type.
    Node(NodeType),
    /// A mark type.
    Mark(MarkType),
}

impl SchemaType {
    /// The node or mark type `name` in the schema of `state` (nodes first).
    pub fn by_name(schema: &crate::rich_editor::model::Schema, name: &str) -> Option<Self> {
        schema
            .node_type(name)
            .map(Self::Node)
            .or_else(|| schema.mark_type(name).map(Self::Mark))
    }
}

/// Merges `attrs` into those of the nodes or marks of `ty` in the
/// selection (the innermost node of `ty` around a cursor or a range's
/// start too); applies when there is one (Tiptap's `updateAttributes`).
pub fn update_attributes(ty: SchemaType, attrs: Attrs) -> BoxCommand {
    command(move |state, mut dispatch| {
        let (node_ty, mark_ty) = match &ty {
            SchemaType::Node(t) => (Some(t), None),
            SchemaType::Mark(t) => (None, Some(t)),
        };
        let run = dispatch.is_some();
        let mut tr = state.tr();
        let mut can_update = false;
        let selection = state.selection();
        let empty = selection.empty();
        for range in selection.ranges() {
            let (from, to) = (range.from.pos, range.to.pos);
            let mut last: Option<(usize, Node, usize, usize)> = None;
            state.doc().nodes_between(from, to, &mut |node, pos, _, _| {
                let is_node_ty = node_ty.is_some_and(|t| node.ty() == t);
                if empty {
                    if is_node_ty {
                        can_update = true;
                        last = Some((
                            pos,
                            node.clone(),
                            pos.max(from),
                            (pos + node.node_size()).min(to),
                        ));
                    }
                    return true;
                }
                if pos < from && is_node_ty {
                    can_update = true;
                    last = Some((
                        pos,
                        node.clone(),
                        pos.max(from),
                        (pos + node.node_size()).min(to),
                    ));
                }
                if pos >= from && pos <= to {
                    if is_node_ty {
                        can_update = true;
                        if run {
                            let _ = tr.set_node_markup(
                                pos,
                                None,
                                Some(merged(Some(node.attrs()), &attrs)),
                                None,
                            );
                        }
                    }
                    if let Some(mark_ty) = mark_ty {
                        for mark in node.marks().iter().filter(|m| m.ty() == mark_ty) {
                            can_update = true;
                            if run
                                && let Ok(mark) =
                                    mark_ty.create(Some(merged(Some(mark.attrs()), &attrs)))
                            {
                                let _ = tr.add_mark(
                                    pos.max(from),
                                    (pos + node.node_size()).min(to),
                                    mark,
                                );
                            }
                        }
                    }
                }
                true
            });
            if let Some((pos, node, trimmed_from, trimmed_to)) = last {
                if run {
                    let _ = tr.set_node_markup(
                        pos,
                        None,
                        Some(merged(Some(node.attrs()), &attrs)),
                        None,
                    );
                }
                if let Some(mark_ty) = mark_ty {
                    for mark in node.marks().iter().filter(|m| m.ty() == mark_ty) {
                        if run
                            && let Ok(mark) =
                                mark_ty.create(Some(merged(Some(mark.attrs()), &attrs)))
                        {
                            let _ = tr.add_mark(trimmed_from, trimmed_to, mark);
                        }
                    }
                }
            }
        }
        if can_update && let Some(dispatch) = dispatch.as_deref_mut() {
            dispatch(tr);
        }
        can_update
    })
}

/// Resets the attributes `keys` (to their defaults) of the nodes or marks
/// of `ty` in the selection (Tiptap's `resetAttributes`).
pub fn reset_attributes(ty: SchemaType, keys: Vec<String>) -> BoxCommand {
    command(move |state, mut dispatch| {
        let without = |attrs: &Attrs| -> Attrs {
            attrs
                .iter()
                .filter(|(k, _)| !keys.contains(k))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        };
        let mut tr = state.tr();
        let mut can_reset = false;
        for range in state.selection().ranges() {
            state
                .doc()
                .nodes_between(range.from.pos, range.to.pos, &mut |node, pos, _, _| {
                    match &ty {
                        SchemaType::Node(t) if node.ty() == t => {
                            can_reset = true;
                            let _ =
                                tr.set_node_markup(pos, None, Some(without(node.attrs())), None);
                        }
                        SchemaType::Mark(t) => {
                            for mark in node.marks().iter().filter(|m| m.ty() == t) {
                                can_reset = true;
                                if let Ok(mark) = t.create(Some(without(mark.attrs()))) {
                                    let _ = tr.add_mark(pos, pos + node.node_size(), mark);
                                }
                            }
                        }
                        _ => {}
                    }
                    true
                });
        }
        if can_reset && let Some(dispatch) = dispatch.as_deref_mut() {
            dispatch(tr);
        }
        can_reset
    })
}

/// Deletes the innermost node of `ty` around the selection's anchor
/// (Tiptap's `deleteNode`).
pub fn delete_node(ty: NodeType) -> BoxCommand {
    command(move |state, mut dispatch| {
        let pos = state.selection().resolved_anchor();
        let Some(depth) = (1..=pos.depth).rev().find(|&d| pos.node(d).ty() == &ty) else {
            return false;
        };
        if dispatch.is_some() {
            let mut tr = state.tr();
            if tr.delete(pos.before(depth), pos.after(depth)).is_err() {
                return false;
            }
            send(&mut dispatch, tr);
        }
        true
    })
}

/// Deletes the empty node the selection's anchor is in (Tiptap's
/// `deleteCurrentNode`).
pub fn delete_current_node() -> BoxCommand {
    command(|state, mut dispatch| {
        let pos = state.selection().resolved_anchor();
        let current = pos.parent();
        if current.content().size() > 0 {
            return false;
        }
        let Some(depth) = (1..=pos.depth)
            .rev()
            .find(|&d| pos.node(d).ty() == current.ty())
        else {
            return false;
        };
        if dispatch.is_some() {
            let mut tr = state.tr();
            if tr.delete(pos.before(depth), pos.after(depth)).is_err() {
                return false;
            }
            send(&mut dispatch, tr);
        }
        true
    })
}

/// Deletes `from..to` (Tiptap's `deleteRange`).
pub fn delete_range(from: usize, to: usize) -> BoxCommand {
    command(move |state, dispatch| with_tr(state, dispatch, |tr| tr.delete(from, to).is_ok()))
}

/// How [`insert_content_at`] inserts.
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct InsertContentOptions {
    /// Puts the cursor after the inserted content (default true).
    pub update_selection: bool,
}

impl Default for InsertContentOptions {
    fn default() -> Self {
        Self {
            update_selection: true,
        }
    }
}

/// Inserts `content` over `from..to` (Tiptap's `insertContentAt`, with the
/// content already parsed): plain text as typed text, keeping the marks
/// there; blocks inserted at an empty textblock replace it.
pub fn insert_content_at(
    from: usize,
    to: usize,
    content: Fragment,
    options: InsertContentOptions,
) -> BoxCommand {
    command(move |state, dispatch| {
        with_tr(state, dispatch, |tr| {
            insert_content_in(tr, from, to, &content, options)
        })
    })
}

/// [`insert_content_at`] over the selection (Tiptap's `insertContent`).
pub fn insert_content(content: Fragment, options: InsertContentOptions) -> BoxCommand {
    command(move |state, dispatch| {
        let selection = state.selection();
        insert_content_at(selection.from(), selection.to(), content.clone(), options)(
            state, dispatch,
        )
    })
}

/// What [`insert_content_at`] does, in `tr`: whether it could.
pub fn insert_content_in(
    tr: &mut Transaction,
    mut from: usize,
    mut to: usize,
    content: &Fragment,
    options: InsertContentOptions,
) -> bool {
    if from > to || to > tr.doc().content().size() {
        return false;
    }
    let nodes = content.children();
    if nodes.iter().any(|node| node.check().is_err()) {
        return false;
    }
    let only_text = nodes.iter().all(|n| n.is_text() && n.marks().is_empty());
    let only_block = nodes.iter().all(Node::is_block);
    if from == to && only_block {
        let Ok(at) = tr.doc().resolve(from) else {
            return false;
        };
        let parent = at.parent();
        if parent.is_textblock() && !parent.ty().spec().code && parent.child_count() == 0 {
            from -= 1;
            to += 1;
        }
    }
    if only_text {
        let text: String = nodes.iter().filter_map(Node::text).collect();
        tr.insert_text(&text, Some(from), Some(to));
    } else {
        let Ok(at) = tr.doc().resolve(from) else {
            return false;
        };
        let parent = at.parent();
        if at.parent_offset == 0
            && (parent.is_text() || parent.is_textblock())
            && parent.content().size() > 0
            && only_block
        {
            from = from.saturating_sub(1);
        }
        if tr.replace_with(from, to, content.clone()).is_err() {
            return false;
        }
    }
    if options.update_selection
        && let Some(last) = tr.steps.len().checked_sub(1)
    {
        selection_to_insertion_end(tr, last, -1);
    }
    true
}

/// Moves `from..to` to `target` (a position before the move), selecting
/// just before where it lands (Tiptap's `cut`).
pub fn cut(from: usize, to: usize, target: usize) -> BoxCommand {
    command(move |state, dispatch| {
        with_tr(state, dispatch, |tr| {
            let Ok(slice) = state.doc().slice(from, to, false) else {
                return false;
            };
            if tr.delete_range(from, to).is_err() {
                return false;
            }
            let at = tr.mapping.map(target, 1);
            if tr.insert(at, slice.content).is_err() {
                return false;
            }
            let pos = at.saturating_sub(1).min(tr.doc().content().size());
            tr.set_selection(TextSelection::create(tr.doc(), pos, None));
            true
        })
    })
}

/// Sets the meta `key` to `value` on the transaction (Tiptap's `setMeta`).
pub fn set_meta(key: String, value: Value) -> BoxCommand {
    command(move |state, dispatch| {
        with_tr(state, dispatch, |tr| {
            tr.set_meta(&key, value.clone());
            true
        })
    })
}

/// Scrolls the selection into view (Tiptap's `scrollIntoView`).
pub fn scroll_into_view() -> BoxCommand {
    command(|state, dispatch| {
        with_tr(state, dispatch, |tr| {
            tr.scroll_into_view();
            true
        })
    })
}

fn join_item(dir: i32) -> BoxCommand {
    command(move |state, mut dispatch| {
        let doc = state.doc();
        let Some(point) = join_point(doc, state.selection().from(), dir) else {
            return false;
        };
        if !can_join_items_at(doc, point) {
            return false;
        }
        let mut tr = state.tr();
        if tr.join(point, 2).is_err() {
            return false;
        }
        if let Some(dispatch) = dispatch.as_deref_mut() {
            dispatch(tr);
        }
        true
    })
}

/// Joins the item (or other node) the selection starts in with the one
/// before it, two levels deep (Tiptap's `joinItemBackward`).
pub fn join_item_backward() -> BoxCommand {
    join_item(-1)
}

/// Joins the item the selection starts in with the one after it (Tiptap's
/// `joinItemForward`).
pub fn join_item_forward() -> BoxCommand {
    join_item(1)
}

/// Selects text from `from` to `to`, each kept inside the document's
/// first and last text positions (Tiptap's `setTextSelection`).
pub fn set_text_selection(from: usize, to: usize) -> BoxCommand {
    command(move |state, dispatch| {
        with_tr(state, dispatch, |tr| {
            let doc = state.doc();
            let min = Selection::at_start(doc).from();
            let max = Selection::at_end(doc).to();
            let (from, to) = (from.clamp(min, max.max(min)), to.clamp(min, max.max(min)));
            tr.set_selection(TextSelection::create(doc, from, Some(to)));
            true
        })
    })
}

/// Selects the node at `pos` (kept inside the document; Tiptap's
/// `setNodeSelection`); does not apply where no node starts there.
pub fn set_node_selection(pos: usize) -> BoxCommand {
    command(move |state, dispatch| {
        let doc = state.doc();
        let pos = pos.min(doc.content().size());
        let Ok(at) = doc.resolve(pos) else {
            return false;
        };
        if at.node_after().is_none() {
            return false;
        }
        with_tr(state, dispatch, |tr| {
            tr.set_selection(NodeSelection::create(doc, pos));
            true
        })
    })
}

/// Where [`focus`] puts the selection.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum FocusPosition {
    /// Where it is.
    #[default]
    Keep,
    /// At the document's start.
    Start,
    /// At the document's end.
    End,
    /// Over the whole document's text.
    All,
    /// At a position (kept inside the document's text).
    Pos(usize),
}

/// The selection a [`FocusPosition`] means in `doc` (`None`: keep it;
/// Tiptap's `resolveFocusPosition`).
pub fn resolve_focus_position(doc: &Node, position: FocusPosition) -> Option<Selection> {
    let start = Selection::at_start(doc);
    let end = Selection::at_end(doc);
    let (min, max) = (start.from(), end.to().max(start.from()));
    match position {
        FocusPosition::Keep => None,
        FocusPosition::Start => Some(start),
        FocusPosition::End => Some(end),
        FocusPosition::All => Some(TextSelection::create(
            doc,
            0usize.clamp(min, max),
            Some(doc.content().size().clamp(min, max)),
        )),
        FocusPosition::Pos(pos) => {
            let pos = pos.clamp(min, max);
            Some(TextSelection::create(doc, pos, None))
        }
    }
}

/// Moves the selection to `position` and asks the views to take the focus
/// (the transaction's [`FOCUS_META`]; Tiptap's `focus`, whose focusing is
/// the view's), scrolling the selection into view.
pub fn focus(position: FocusPosition) -> BoxCommand {
    command(move |state, dispatch| {
        with_tr(state, dispatch, |tr| {
            if let Some(selection) = resolve_focus_position(state.doc(), position)
                && &selection != state.selection()
            {
                tr.set_selection(selection);
            }
            tr.set_meta(FOCUS_META, Value::Bool(true));
            tr.scroll_into_view();
            true
        })
    })
}

// --- Lists --------------------------------------------------------------------

/// Whether `node` is a list for [`toggle_list`]: its type is in the group
/// `list` (Tiptap's `isList`), or it holds items of `item_ty`.
pub fn is_list_node(node: &Node, item_ty: &NodeType) -> bool {
    node.ty().is_in_group("list")
        || (!node.is_textblock()
            && node.child_count() > 0
            && node.content().iter().all(|child| child.ty() == item_ty))
}

fn list_types_compatible(a: &Node, b: &Node) -> bool {
    let norm = |node: &Node| match node.attrs().get("type") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s == "1" => None,
        Some(other) => Some(other.clone()),
    };
    norm(a) == norm(b)
}

/// Joins the list of `list_ty` around the selection with a list of its
/// type right before it (Tiptap's `joinListBackwards`); always applies.
pub fn join_list_backwards(list_ty: NodeType) -> BoxCommand {
    command(move |state, dispatch| {
        with_tr(state, dispatch, |tr| {
            let doc = state.doc();
            let Some(list) = find_parent_node(state.selection(), &|n| n.ty() == &list_ty) else {
                return true;
            };
            let Ok(at) = doc.resolve(list.pos.saturating_sub(1)) else {
                return true;
            };
            if at.depth < list.depth {
                return true;
            }
            let before = at.before(list.depth);
            let Some(node_before) = doc.node_at(before) else {
                return true;
            };
            if node_before.ty() != list.node.ty()
                || !can_join(doc, list.pos)
                || !list_types_compatible(&list.node, &node_before)
            {
                return true;
            }
            let _ = tr.join(list.pos, 1);
            true
        })
    })
}

/// Joins the list of `list_ty` around the selection with a list of its
/// type right after it (Tiptap's `joinListForwards`); always applies.
pub fn join_list_forwards(list_ty: NodeType) -> BoxCommand {
    command(move |state, dispatch| {
        with_tr(state, dispatch, |tr| {
            let doc = state.doc();
            let Some(list) = find_parent_node(state.selection(), &|n| n.ty() == &list_ty) else {
                return true;
            };
            let Ok(at) = doc.resolve(list.start) else {
                return true;
            };
            let after = at.after(list.depth);
            let Some(node_after) = doc.node_at(after) else {
                return true;
            };
            if node_after.ty() != list.node.ty()
                || !can_join(doc, after)
                || !list_types_compatible(&list.node, &node_after)
            {
                return true;
            }
            let _ = tr.join(after, 1);
            true
        })
    })
}

// The list's items as items of `item_ty` in lists of `list_ty` (nested
// lists too); `None` when some content does not fit.
fn convert_list(
    list: &Node,
    list_ty: &NodeType,
    item_ty: &NodeType,
    attrs: Option<Attrs>,
) -> Option<Node> {
    let source_item = list.first_child()?.ty().clone();
    let mut items = Vec::new();
    for item in list.content().iter() {
        let mut content = Vec::new();
        for child in item.content().iter() {
            if is_list_node(child, &source_item) {
                content.push(convert_list(child, list_ty, item_ty, None)?);
            } else {
                content.push(child.clone());
            }
        }
        let content = Fragment::from(content);
        if !item_ty.valid_content(&content) {
            return None;
        }
        items.push(item_ty.create(None, content, vec![]).ok()?);
    }
    let content = Fragment::from(items);
    if !list_ty.valid_content(&content) {
        return None;
    }
    list_ty.create(attrs, content, vec![]).ok()
}

// Takes every selected textblock out of every list of `item_ty` around it,
// nested ones too, as a word processor's list button does when turned off
// (Tiptap lifts one level only, which leaves a nested item in a list). The
// selection stays on the same text.
fn lift_out_of_lists(item_ty: NodeType) -> BoxCommand {
    command(move |state, dispatch| {
        let lift = lift_list_item(item_ty.clone());
        if !lift(state, None) {
            return false;
        }
        let Some(dispatch) = dispatch else {
            return true;
        };
        // Textblocks by their index in the document: lifting keeps their
        // order and count.
        let textblocks = |doc: &Node| {
            let mut starts = Vec::new();
            doc.descendants(&mut |node, pos, _, _| {
                if node.is_textblock() {
                    starts.push(pos + 1);
                    return false;
                }
                true
            });
            starts
        };
        let selection = state.selection();
        let place = |pos: usize, starts: &[usize]| {
            let i = starts.partition_point(|&s| s <= pos).saturating_sub(1);
            (i, pos - starts.get(i).copied().unwrap_or(0))
        };
        let starts = textblocks(state.doc());
        let (first, _) = place(selection.from(), &starts);
        let (last, _) = place(selection.to(), &starts);
        let anchor = place(selection.anchor(), &starts);
        let head = place(selection.head(), &starts);
        let mut current = state.clone();
        let mut whole = state.tr();
        for index in first..=last {
            // At most as many lifts as lists can nest.
            for _ in 0..64 {
                let Some(&start) = textblocks(current.doc()).get(index) else {
                    break;
                };
                let in_item = current
                    .doc()
                    .resolve(start)
                    .is_ok_and(|at| (1..=at.depth).any(|d| at.node(d).ty() == &item_ty));
                if !in_item {
                    break;
                }
                let mut tr = current.tr();
                tr.set_selection(TextSelection::create(current.doc(), start, None));
                let Ok(at_block) = current.apply(tr) else {
                    return false;
                };
                let mut made = None;
                if !lift(&at_block, Some(&mut |tr| made = Some(tr))) {
                    break;
                }
                let Some(tr) = made else { break };
                for step in &tr.steps {
                    if whole.step(step.boxed_clone()).is_err() {
                        return false;
                    }
                }
                let Ok(next) = at_block.apply(tr) else {
                    return false;
                };
                current = next;
            }
        }
        // What was left of a list on both sides of a lifted block, now
        // side by side, is one list again.
        while let Some(at) = adjacent_lists(whole.doc(), &item_ty) {
            if !can_join(whole.doc(), at) || whole.join(at, 1).is_err() {
                break;
            }
        }
        let starts = textblocks(whole.doc());
        let at = |(i, offset): (usize, usize)| starts.get(i).map(|s| s + offset);
        if let (Some(anchor), Some(head)) = (at(anchor), at(head)) {
            let size = whole.doc().content().size();
            whole.set_selection(TextSelection::create(
                whole.doc(),
                anchor.min(size),
                Some(head.min(size)),
            ));
        }
        dispatch(whole);
        true
    })
}

// The first place in `doc` between two lists of one type that join.
fn adjacent_lists(doc: &Node, item_ty: &NodeType) -> Option<usize> {
    fn within(node: &Node, start: usize, item_ty: &NodeType) -> Option<usize> {
        let mut at = start;
        for i in 0..node.child_count() {
            let child = node.child(i);
            if i > 0 {
                let before = node.child(i - 1);
                if before.ty() == child.ty()
                    && is_list_node(child, item_ty)
                    && list_types_compatible(before, child)
                {
                    return Some(at);
                }
            }
            if !child.is_textblock()
                && !child.is_leaf()
                && let Some(found) = within(child, at + 1, item_ty)
            {
                return Some(found);
            }
            at += child.node_size();
        }
        None
    }
    within(doc, 0, item_ty)
}

// The outermost list of the lists nested around `at` from the one at
// `depth`: up through items whose parents are lists. Its position and node.
fn outermost_list(
    at: &ResolvedPos,
    depth: usize,
    is_list: &dyn Fn(&Node) -> bool,
) -> (usize, Node) {
    let mut depth = depth;
    while depth >= 3 && !is_list(at.node(depth - 1)) && is_list(at.node(depth - 2)) {
        depth -= 2;
    }
    (at.before(depth), at.node(depth).clone())
}

// Tiptap's `findNodePosition`: where `target` (that very node) is in `root`.
fn find_node_position(root: &Node, target: &Node) -> Option<usize> {
    let mut found = None;
    root.descendants(&mut |node, pos, _, _| {
        if found.is_some() {
            return false;
        }
        if node.ptr_eq(target) {
            found = Some(pos);
            return false;
        }
        true
    });
    found
}

/// Lifts the selected items of `item_ty` out of a list of `list_ty`, turns
/// another list around the selection into one of `list_ty`, or wraps the
/// selected blocks in one (with `attrs`), clearing them first when they
/// cannot be wrapped as they are; then joins it with lists of its type
/// next to it. With `keep_marks`, the marks at the selection stay stored
/// for the text typed next (Tiptap's `toggleList`).
pub fn toggle_list(
    list_ty: NodeType,
    item_ty: NodeType,
    keep_marks: bool,
    attrs: Attrs,
) -> BoxCommand {
    command(move |state, dispatch| {
        let selection = state.selection();
        let (from, to) = (selection.resolved_from(), selection.resolved_to());
        let Some(range) = from.block_range(to, None) else {
            return false;
        };
        let marks = match state.stored_marks() {
            Some(marks) => Some(marks.to_vec()),
            None if to.parent_offset > 0 => Some(from.marks()),
            None => None,
        };
        let is_list = |node: &Node| is_list_node(node, &item_ty);
        // The list holding the whole range: a selection from a nested item
        // to an item of the outer list is in the outer one.
        let parent_list = (1..=range.depth).rev().find_map(|depth| {
            let node = from.node(depth);
            is_list(node).then(|| ParentNode {
                pos: from.before(depth),
                start: from.start(depth),
                depth,
                node: node.clone(),
            })
        });
        let doc = state.doc();
        let all_selected = selection.from() == 0 && selection.to() == doc.content().size();
        let whole_doc_list = (all_selected && doc.child_count() == 1 && is_list(doc.child(0)))
            .then(|| doc.child(0).clone());
        let inside = parent_list
            .as_ref()
            .is_some_and(|list| range.depth >= 1 && range.depth <= list.depth + 1);
        let current = parent_list
            .as_ref()
            .map(|list| (list.pos, list.node.clone()))
            .or_else(|| whole_doc_list.clone().map(|node| (0, node)));
        let joins = || {
            vec![
                join_list_backwards(list_ty.clone()),
                join_list_forwards(list_ty.clone()),
            ]
        };
        if (inside || whole_doc_list.is_some())
            && let Some((list_pos, list_node)) = current
        {
            if list_node.ty() == &list_ty {
                if all_selected && whole_doc_list.is_some() {
                    let inner = command(|state, dispatch| {
                        let doc = state.doc();
                        let Some(list) = doc.first_child() else {
                            return false;
                        };
                        let (Ok(start), Ok(end)) =
                            (doc.resolve(1), doc.resolve(list.node_size() - 1))
                        else {
                            return false;
                        };
                        with_tr(state, dispatch, |tr| {
                            tr.set_selection(TextSelection::between(&start, &end, None));
                            true
                        })
                    });
                    return chain(vec![inner, lift_out_of_lists(item_ty.clone())])(state, dispatch);
                }
                return lift_out_of_lists(item_ty.clone())(state, dispatch);
            }
            if list_ty.valid_content(list_node.content()) {
                // The whole list changes, every level of it, as a word
                // processor's list does: from its outermost list down.
                let (root_pos, root) = parent_list
                    .as_ref()
                    .map(|list| outermost_list(from, list.depth, &is_list))
                    .unwrap_or((list_pos, list_node.clone()));
                let mut targets = Vec::new();
                if root.ty() != &list_ty {
                    targets.push(root_pos);
                }
                root.descendants(&mut |node, pos, _, _| {
                    if is_list(node)
                        && node.ty() != &list_ty
                        && list_ty.valid_content(node.content())
                    {
                        targets.push(root_pos + 1 + pos);
                    }
                    true
                });
                let retype = {
                    let list_ty = list_ty.clone();
                    command(move |state, dispatch| {
                        with_tr(state, dispatch, |tr| {
                            targets.iter().all(|&pos| {
                                tr.set_node_markup(pos, Some(list_ty.clone()), None, None)
                                    .is_ok()
                            })
                        })
                    })
                };
                let mut commands = vec![retype];
                commands.extend(joins());
                return chain(commands)(state, dispatch);
            }
            let current_item = list_node.first_child().map(|n| n.ty().clone());
            if current_item.is_some_and(|ty| ty != item_ty) {
                let Some(new_list) =
                    convert_list(&list_node, &list_ty, &item_ty, Some(attrs.clone()))
                else {
                    return false;
                };
                let replace = command(move |state, dispatch| {
                    with_tr(state, dispatch, |tr| {
                        let selection = state.selection();
                        let (anchor, head) = (
                            selection.resolved_anchor().clone(),
                            selection.resolved_head().clone(),
                        );
                        let end = list_pos + list_node.node_size();
                        if tr
                            .replace_with(list_pos, end, Fragment::from(vec![new_list.clone()]))
                            .is_err()
                        {
                            return false;
                        }
                        if anchor.parent().inline_content() && head.parent().inline_content() {
                            // The converted list keeps the textblocks, so
                            // the selection's parents are where they were
                            // in the source list.
                            let anchor_at = find_node_position(&list_node, anchor.parent());
                            let head_at = find_node_position(&list_node, head.parent());
                            if let (Some(a), Some(h)) = (anchor_at, head_at) {
                                let size = tr.doc().content().size();
                                let anchor = (list_pos + a + 2 + anchor.parent_offset).min(size);
                                let head = (list_pos + h + 2 + head.parent_offset).min(size);
                                tr.set_selection(TextSelection::create(
                                    tr.doc(),
                                    anchor,
                                    Some(head),
                                ));
                            }
                        }
                        true
                    })
                });
                let mut commands = vec![replace];
                commands.extend(joins());
                return chain(commands)(state, dispatch);
            }
        }
        let wrap = wrap_in_list(list_ty.clone(), Some(attrs.clone()));
        let can_wrap = wrap(state, None);
        let keep = keep_marks && dispatch.is_some();
        let prepare = match (keep, marks) {
            (true, Some(marks)) => {
                let marks = marks.clone();
                let clear = (!can_wrap).then(clear_nodes);
                command(move |state, dispatch| {
                    let mut made = None;
                    if let Some(clear) = &clear
                        && !clear(state, Some(&mut |tr| made = Some(tr)))
                    {
                        return false;
                    }
                    let mut tr = made.unwrap_or_else(|| state.tr());
                    tr.ensure_marks(marks.clone());
                    if let Some(dispatch) = dispatch {
                        dispatch(tr);
                    }
                    true
                })
            }
            _ if can_wrap => noop(),
            _ => clear_nodes(),
        };
        let mut commands = vec![prepare, wrap];
        commands.extend(joins());
        chain(commands)(state, dispatch)
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{super::test_util::*, *};

    fn named(s: &crate::rich_editor::model::Schema, names: &[&str]) -> NodeType {
        names
            .iter()
            .find_map(|name| s.node_type(name))
            .expect("one of the names")
    }

    fn list_names(s: &crate::rich_editor::model::Schema) -> (NodeType, NodeType, NodeType) {
        (
            named(s, &["bulletList"]),
            named(s, &["orderedList"]),
            named(s, &["listItem"]),
        )
    }

    fn attrs(value: Value) -> Attrs {
        value
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    fn list(
        s: &crate::rich_editor::model::Schema,
        ty: &NodeType,
        item: &NodeType,
        texts: &[&str],
    ) -> Node {
        let items = texts
            .iter()
            .map(|t| {
                item.create(None, Fragment::from(vec![p(s, t)]), vec![])
                    .unwrap()
            })
            .collect::<Vec<_>>();
        ty.create(None, Fragment::from(items), vec![]).unwrap()
    }

    #[test]
    fn toggle_list_wraps_converts_and_lifts() {
        let s = schema();
        let (bullet, ordered, item) = list_names(&s);
        let doc = n(&s, "doc", vec![p(&s, "ab")]);
        let toggle = toggle_list(bullet.clone(), item.clone(), false, Attrs::new());
        let on = apply(&state(doc.clone(), 2, 2), toggle.as_ref()).unwrap();
        assert_eq!(on.doc().child(0).ty(), &bullet);
        // To an ordered list: the list node changes type only.
        let to_ordered = toggle_list(ordered.clone(), item.clone(), false, Attrs::new());
        let ordered_state = apply(&on, to_ordered.as_ref()).unwrap();
        assert_eq!(ordered_state.doc().child(0).ty(), &ordered);
        assert_eq!(ordered_state.doc().text_content(), "ab");
        // And off again.
        let off = apply(&ordered_state, to_ordered.as_ref()).unwrap();
        assert!(off.doc().eq(&doc), "{:?}", off.doc().to_json());
    }

    // ol[li[p a, ol[li[p b]]], li[p c]]: "a" at 3, "b" at 8, "c" at 15.
    fn nested(s: &crate::rich_editor::model::Schema, outer: &NodeType, inner: &NodeType) -> Node {
        let item = named(s, &["listItem"]);
        let inner = list(s, inner, &item, &["b"]);
        let first = item
            .create(None, Fragment::from(vec![p(s, "a"), inner]), vec![])
            .unwrap();
        let second = item
            .create(None, Fragment::from(vec![p(s, "c")]), vec![])
            .unwrap();
        let outer = outer
            .create(None, Fragment::from(vec![first, second]), vec![])
            .unwrap();
        n(s, "doc", vec![outer])
    }

    fn list_types(doc: &Node) -> Vec<String> {
        let mut types = Vec::new();
        doc.descendants(&mut |node, _, _, _| {
            if node.ty().name().ends_with("List") {
                types.push(node.ty().name().to_owned());
            }
            true
        });
        types
    }

    #[test]
    fn toggle_list_converts_every_level_of_a_nested_list() {
        let s = schema();
        let (bullet, ordered, item) = list_names(&s);
        let to_bullet = toggle_list(bullet.clone(), item.clone(), false, Attrs::new());
        // From the nested item, the outer item and a selection across both.
        for (anchor, head) in [(8, 8), (3, 3), (3, 15), (8, 15)] {
            let doc = nested(&s, &ordered, &ordered);
            let next = apply(&state(doc, anchor, head), to_bullet.as_ref()).unwrap();
            assert_eq!(
                list_types(next.doc()),
                ["bulletList", "bulletList"],
                "{anchor}..{head}"
            );
            assert_eq!(next.doc().text_content(), "abc");
        }
        // Mixed levels become one type; the same type again lifts.
        let doc = nested(&s, &ordered, &bullet);
        let next = apply(&state(doc, 3, 3), to_bullet.as_ref()).unwrap();
        assert_eq!(list_types(next.doc()), ["bulletList", "bulletList"]);
        let off = apply(&next, to_bullet.as_ref()).unwrap();
        assert_eq!(off.doc().child(0).ty().name(), "paragraph");
    }

    #[test]
    fn toggle_list_joins_lists_around() {
        let s = schema();
        let (bullet, _, item) = list_names(&s);
        let doc = n(
            &s,
            "doc",
            vec![
                list(&s, &bullet, &item, &["a"]),
                p(&s, "b"),
                list(&s, &bullet, &item, &["c"]),
            ],
        );
        // In "b": the paragraph after the first list (size 7).
        let toggle = toggle_list(bullet.clone(), item.clone(), false, Attrs::new());
        let joined = apply(&state(doc, 8, 8), toggle.as_ref()).unwrap();
        assert_eq!(joined.doc().child_count(), 1);
        assert_eq!(joined.doc().child(0).child_count(), 3);
    }

    #[test]
    fn set_node_clears_a_list_first() {
        let s = schema();
        let (bullet, _, item) = list_names(&s);
        let heading = s.node_type("heading").unwrap();
        let doc = n(&s, "doc", vec![list(&s, &bullet, &item, &["ab"])]);
        let set = set_node(heading.clone(), attrs(json!({"level": 2})));
        let out = apply(&state(doc, 3, 3), set.as_ref()).unwrap();
        assert_eq!(out.doc().child(0).ty(), &heading);
        assert_eq!(out.doc().child(0).attrs().get("level"), Some(&json!(2)));
    }

    #[test]
    fn toggle_node_goes_back_to_the_toggle_type() {
        let s = schema();
        let heading = s.node_type("heading").unwrap();
        let paragraph = s.node_type("paragraph").unwrap();
        let doc = n(&s, "doc", vec![p(&s, "ab")]);
        let toggle = toggle_node(
            heading.clone(),
            paragraph.clone(),
            attrs(json!({"level": 1})),
        );
        let on = apply(&state(doc.clone(), 2, 2), toggle.as_ref()).unwrap();
        assert_eq!(on.doc().child(0).ty(), &heading);
        let off = apply(&on, toggle.as_ref()).unwrap();
        assert_eq!(off.doc().child(0).ty(), &paragraph);
    }

    #[test]
    fn toggle_wrap_wraps_and_lifts() {
        let s = schema();
        let quote = s.node_type("blockquote").unwrap();
        let doc = n(&s, "doc", vec![p(&s, "ab")]);
        let toggle = toggle_wrap(quote.clone(), Attrs::new());
        let on = apply(&state(doc.clone(), 2, 2), toggle.as_ref()).unwrap();
        assert_eq!(on.doc().child(0).ty(), &quote);
        let off = apply(&on, toggle.as_ref()).unwrap();
        assert!(off.doc().eq(&doc));
    }

    #[test]
    fn marks_set_merge_unset_and_extend() {
        let s = schema();
        let link = s.mark_type("link").unwrap();
        let doc = n(&s, "doc", vec![p(&s, "hello world")]);
        let on = apply(
            &state(doc, 1, 6),
            set_mark(link.clone(), attrs(json!({"href": "a"}))).as_ref(),
        )
        .unwrap();
        assert!(is_mark_active(
            &on,
            Some(&link),
            &attrs(json!({"href": "a"}))
        ));
        // A cursor inside: extendMarkRange selects the link.
        let cursor = on.apply({
            let mut tr = on.tr();
            tr.set_selection(TextSelection::create(on.doc(), 3, None));
            tr
        });
        let cursor = cursor.unwrap();
        let extended = apply(&cursor, extend_mark_range(link.clone(), None).as_ref()).unwrap();
        assert_eq!(
            (extended.selection().from(), extended.selection().to()),
            (1, 6)
        );
        // updateAttributes merges.
        let updated = apply(
            &extended,
            update_attributes(SchemaType::Mark(link.clone()), attrs(json!({"title": "t"})))
                .as_ref(),
        );
        if let Some(updated) = updated {
            assert!(is_mark_active(
                &updated,
                Some(&link),
                &attrs(json!({"href": "a"}))
            ));
        }
        // unsetMark with extendEmptyMarkRange from the cursor removes it all.
        let off = apply(&cursor, unset_mark(link.clone(), true).as_ref()).unwrap();
        assert!(!off.doc().range_has_mark(1, 12, &link));
        // toggleMark: active, so it unsets.
        let toggled = apply(
            &extended,
            toggle_mark(link.clone(), Attrs::new(), false).as_ref(),
        )
        .unwrap();
        assert!(!toggled.doc().range_has_mark(1, 6, &link));
        // unsetAllMarks.
        let none = apply(&extended, unset_all_marks().as_ref()).unwrap();
        assert!(!none.doc().range_has_mark(1, 6, &link));
    }

    #[test]
    fn node_attributes_update_and_reset() {
        let s = schema();
        let heading = s.node_type("heading").unwrap();
        let h = heading
            .create(
                Some(attrs(json!({"level": 3}))),
                Fragment::from(vec![t(&s, "ab")]),
                vec![],
            )
            .unwrap();
        let doc = n(&s, "doc", vec![h]);
        let st = state(doc, 2, 2);
        let up = apply(
            &st,
            update_attributes(
                SchemaType::Node(heading.clone()),
                attrs(json!({"level": 2})),
            )
            .as_ref(),
        )
        .unwrap();
        assert_eq!(up.doc().child(0).attrs().get("level"), Some(&json!(2)));
        let reset = apply(
            &up,
            reset_attributes(SchemaType::Node(heading.clone()), vec!["level".into()]).as_ref(),
        )
        .unwrap();
        let default = heading.compute_attrs(None).unwrap();
        assert_eq!(
            reset.doc().child(0).attrs().get("level"),
            default.get("level")
        );
        // Nothing of the type: does not apply.
        let quote = s.node_type("blockquote").unwrap();
        assert!(
            apply(
                &st,
                update_attributes(SchemaType::Node(quote), Attrs::new()).as_ref()
            )
            .is_none()
        );
    }

    #[test]
    fn deleting_nodes_and_ranges() {
        let s = schema();
        let doc = n(
            &s,
            "doc",
            vec![n(&s, "blockquote", vec![p(&s, "ab")]), p(&s, "")],
        );
        let quote = s.node_type("blockquote").unwrap();
        let out = apply(
            &state(doc.clone(), 2, 2),
            delete_node(quote.clone()).as_ref(),
        )
        .unwrap();
        assert_eq!(out.doc().child_count(), 1);
        assert!(apply(&state(doc.clone(), 2, 2), delete_current_node().as_ref()).is_none());
        let out = apply(&state(doc.clone(), 7, 7), delete_current_node().as_ref()).unwrap();
        assert_eq!(out.doc().child_count(), 1);
        // 2..3 is the "a" of the quoted paragraph.
        let out = apply(&state(doc, 2, 2), delete_range(2, 3).as_ref()).unwrap();
        assert_eq!(out.doc().text_content(), "b");
    }

    #[test]
    fn insert_content_at_replaces_an_empty_paragraph_and_types_text() {
        let s = schema();
        let doc = n(&s, "doc", vec![p(&s, "ab"), p(&s, "")]);
        let quote = n(&s, "blockquote", vec![p(&s, "q")]);
        let out = apply(
            &state(doc.clone(), 5, 5),
            insert_content_at(
                5,
                5,
                Fragment::from(vec![quote]),
                InsertContentOptions::default(),
            )
            .as_ref(),
        )
        .unwrap();
        assert_eq!(out.doc().child_count(), 2);
        assert_eq!(out.doc().child(1).ty().name(), "blockquote");
        let typed = apply(
            &state(doc, 2, 2),
            insert_content_at(
                2,
                2,
                Fragment::from(vec![t(&s, "X")]),
                InsertContentOptions::default(),
            )
            .as_ref(),
        )
        .unwrap();
        assert_eq!(typed.doc().child(0).text_content(), "aXb");
        assert_eq!(typed.selection().from(), 3);
    }

    #[test]
    fn selections_focus_meta_and_cut() {
        let s = schema();
        let doc = n(&s, "doc", vec![p(&s, "ab"), p(&s, "cd")]);
        let st = state(doc.clone(), 1, 1);
        let out = apply(&st, set_text_selection(0, 100).as_ref()).unwrap();
        assert_eq!((out.selection().from(), out.selection().to()), (1, 7));
        let mut made = None;
        assert!(focus(FocusPosition::End)(
            &st,
            Some(&mut |tr| made = Some(tr))
        ));
        let tr = made.unwrap();
        assert_eq!(tr.get_meta(FOCUS_META), Some(&Value::Bool(true)));
        assert_eq!(tr.selection().from(), 7);
        let cut_state = apply(&st, cut(1, 3, 7).as_ref()).unwrap();
        assert_eq!(cut_state.doc().child(0).text_content(), "");
        // Tiptap maps 7 past the deleted range to 5, the end of "cd".
        assert_eq!(cut_state.doc().child(1).text_content(), "cdab");
        let meta = apply(&st, set_meta("x".into(), json!(1)).as_ref()).unwrap();
        assert!(meta.doc().eq(&doc));
    }

    #[test]
    fn join_items() {
        let s = schema();
        let (bullet, _, item) = list_names(&s);
        let doc = n(&s, "doc", vec![list(&s, &bullet, &item, &["a", "b"])]);
        // At the start of "b": item 1 is 1..6, item 2's paragraph text at 8.
        let out = apply(&state(doc.clone(), 8, 8), join_item_backward().as_ref()).unwrap();
        assert_eq!(out.doc().child(0).child_count(), 1);
        assert!(apply(&state(doc, 3, 3), join_item_backward().as_ref()).is_none());
    }
}
