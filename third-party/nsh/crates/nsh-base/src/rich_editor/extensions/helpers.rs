//! Tiptap's core commands the starter's key bindings, list keymap and code
//! block bindings run as steps of a chain (`clearNodes`,
//! `deleteCurrentNode`, `joinItemForward`, `setHardBreak`,
//! `updateAttributes`, `insertDefaultBlock`), with the helpers they share
//! (`findParentNode`, `isAtStartOfNode`, chains). Ported from
//! `@tiptap/core`'s `commands/` and `helpers/`, for the starter's own use;
//! `setNode`, `toggleNode`, `toggleWrap` and `toggleList` are
//! `commands::tiptap`'s.

use serde_json::Value;

use crate::rich_editor::{
    commands::{BoxCommand, Dispatch, command},
    model::{Mark, Node, NodeType, ResolvedPos},
    state::{EditorState, EditorStateConfig, Selection},
    transform::{join_point, lift_target},
};

/// A command function, as [`chain`] takes them.
pub(crate) type Step<'a> = &'a dyn Fn(&EditorState, Dispatch<'_>) -> bool;

/// Runs `steps` one after the other, each on the state the ones before made,
/// into one transaction (Tiptap's `chain().….run()`): whether every step
/// applied. The transaction is dispatched when any step changed something.
pub(crate) fn chain(state: &EditorState, dispatch: Dispatch<'_>, steps: &[Step<'_>]) -> bool {
    let mut tr = state.tr();
    let mut current = state.clone();
    let mut all = true;
    for step in steps {
        let mut made = None;
        if !step(&current, Some(&mut |t| made = Some(t))) {
            all = false;
            continue;
        }
        let Some(made) = made else {
            continue;
        };
        for step in &made.steps {
            if tr.step(step.clone()).is_err() {
                return false;
            }
        }
        if made.selection_set() {
            tr.set_selection(made.selection());
        }
        if made.stored_marks_set() {
            tr.set_stored_marks(made.stored_marks().map(<[Mark]>::to_vec));
        }
        for (key, value) in made.meta_entries() {
            tr.set_meta(key, value.clone());
        }
        if made.scrolled_into_view() {
            tr.scroll_into_view();
        }
        // The next step sees the document and selection so far, without the
        // plugins' appended transactions (they run once, on the whole).
        let config = EditorStateConfig::new(state.schema().clone())
            .doc(tr.doc().clone())
            .selection(tr.selection());
        let Ok(next) = EditorState::create(config) else {
            return false;
        };
        current = match tr.stored_marks() {
            Some(marks) => {
                let mut with_marks = next.tr();
                with_marks.set_stored_marks(Some(marks.to_vec()));
                next.apply(with_marks).unwrap_or(next)
            }
            None => next,
        };
    }
    if let Some(dispatch) = dispatch
        && (tr.doc_changed() || tr.selection_set() || tr.stored_marks_set())
    {
        dispatch(tr);
    }
    all
}

/// The innermost ancestor of the selection's start (from the start's parent
/// out) that `predicate` takes, as Tiptap's `findParentNode`: the position
/// before it (0 for the document) and its depth.
pub(crate) fn find_parent_node(
    from: &ResolvedPos,
    predicate: impl Fn(&Node) -> bool,
) -> Option<ParentNode> {
    (0..=from.depth).rev().find_map(|depth| {
        let node = from.node(depth);
        predicate(node).then(|| ParentNode {
            pos: if depth > 0 { from.before(depth) } else { 0 },
            depth,
        })
    })
}

/// An ancestor [`find_parent_node`] found.
pub(crate) struct ParentNode {
    pub(crate) pos: usize,
    pub(crate) depth: usize,
}

/// Whether the selection is a cursor at the start of its parent (Tiptap's
/// `isAtStartOfNode`).
pub(crate) fn is_at_start_of_node(state: &EditorState) -> bool {
    let selection = state.selection();
    selection.resolved_from().parent_offset == 0 && selection.from() == selection.to()
}

/// Whether the cursor is at the end of the content of its innermost node
/// of `ty` (Tiptap's `isAtEndOfNode` with a type).
pub(crate) fn is_at_end_of_node(state: &EditorState, ty: &NodeType) -> bool {
    let selection = state.selection();
    let Some(parent) = find_parent_node(selection.resolved_from(), |n| n.ty() == ty) else {
        return false;
    };
    let Ok(inside) = state.doc().resolve(parent.pos + 1) else {
        return false;
    };
    selection.anchor() + 1 == inside.end(inside.depth)
}

/// The marks typing at the selection would get: the stored ones, else the
/// cursor's unless it is at the start of its block (Tiptap's
/// `storedMarks || ($to.parentOffset && $from.marks())`), only those that
/// carry on into a split (`keepOnSplit`).
pub(crate) fn splittable_marks(state: &EditorState) -> Option<Vec<Mark>> {
    let selection = state.selection();
    let marks = match state.stored_marks() {
        Some(marks) => marks.to_vec(),
        None if selection.resolved_to().parent_offset > 0 => selection.resolved_from().marks(),
        None => return None,
    };
    Some(
        marks
            .into_iter()
            .filter(|m| m.ty.spec().keep_on_split)
            .collect(),
    )
}

/// Turns the textblocks of the selection into their parents' default type
/// and lifts every block of it out of its wrappers (Tiptap's
/// `clearNodes`).
pub(crate) fn clear_nodes(state: &EditorState, dispatch: Dispatch<'_>) -> bool {
    let Some(dispatch) = dispatch else {
        return true;
    };
    let mut tr = state.tr();
    for range in state.selection().ranges() {
        let mut nodes = Vec::new();
        state
            .doc()
            .nodes_between(range.from.pos, range.to.pos, &mut |node, pos, _, _| {
                if !node.is_text() {
                    nodes.push((node.clone(), pos));
                }
                true
            });
        for (node, pos) in nodes {
            let from = tr.mapping.map(pos, 1);
            let to = tr.mapping.map(pos + node.node_size(), 1);
            let (Ok(from), Ok(to)) = (tr.doc().resolve(from), tr.doc().resolve(to)) else {
                continue;
            };
            let Some(node_range) = from.block_range(&to, None) else {
                continue;
            };
            let target = lift_target(&node_range);
            if node.is_textblock()
                && let Some(default) = from
                    .parent()
                    .content_match_at(from.index(from.depth))
                    .and_then(|m| m.default_type())
            {
                let _ = tr.set_node_markup(node_range.start(), Some(default), None, None);
            }
            if let Some(target) = target {
                let _ = tr.lift(&node_range, target);
            }
        }
    }
    dispatch(tr);
    true
}

/// Deletes the empty node the cursor is in (Tiptap's `deleteCurrentNode`).
pub(crate) fn delete_current_node(state: &EditorState, dispatch: Dispatch<'_>) -> bool {
    let anchor = state.selection().resolved_anchor();
    let current = anchor.parent();
    if current.content().size() > 0 {
        return false;
    }
    for depth in (1..=anchor.depth).rev() {
        if anchor.node(depth).ty() == current.ty() {
            if let Some(dispatch) = dispatch {
                let mut tr = state.tr();
                if tr
                    .delete(anchor.before(depth), anchor.after(depth))
                    .is_err()
                {
                    return false;
                }
                tr.scroll_into_view();
                dispatch(tr);
            }
            return true;
        }
    }
    false
}

/// Joins the node at the selection's start with the one after it, two
/// levels deep (the next list item into this one; Tiptap's
/// `joinItemForward`).
pub(crate) fn join_item_forward(state: &EditorState, dispatch: Dispatch<'_>) -> bool {
    let Some(point) = join_point(state.doc(), state.selection().from(), 1) else {
        return false;
    };
    let Ok(at) = state.doc().resolve(point) else {
        return false;
    };
    let (Some(before), Some(after)) = (at.node_before(), at.node_after()) else {
        return false;
    };
    if before.ty().spec().isolating || after.ty().spec().isolating {
        return false;
    }
    let mut tr = state.tr();
    if tr.join(point, 2).is_err() {
        return false;
    }
    if let Some(dispatch) = dispatch {
        dispatch(tr);
    }
    true
}

/// Leaves a code block, else inserts a node of `ty` (a hard break), keeping
/// the marks typing had when `keep_marks` (Tiptap's `setHardBreak`).
pub(crate) fn set_hard_break(ty: NodeType, keep_marks: bool) -> BoxCommand {
    command(move |state, mut dispatch| {
        let exit = match &mut dispatch {
            Some(dispatch) => crate::rich_editor::commands::exit_code(state, Some(&mut **dispatch)),
            None => crate::rich_editor::commands::exit_code(state, None),
        };
        if exit {
            return true;
        }
        if state
            .selection()
            .resolved_from()
            .parent()
            .ty()
            .spec()
            .isolating
        {
            return false;
        }
        let Ok(node) = ty.create(None, Default::default(), vec![]) else {
            return false;
        };
        if let Some(dispatch) = dispatch {
            let marks = splittable_marks(state);
            let mut tr = state.tr();
            tr.replace_selection_with(node, false);
            if keep_marks && let Some(marks) = marks {
                tr.ensure_marks(marks);
            }
            tr.scroll_into_view();
            dispatch(tr);
        }
        true
    })
}

/// Sets `attr` to `value` on every node of a type in `types` in the
/// selection (Tiptap's `updateAttributes`, as `setTextAlign` runs it):
/// whether the schema has one of the types.
pub(crate) fn update_attribute(
    types: Vec<NodeType>,
    attr: &'static str,
    value: Value,
) -> BoxCommand {
    command(move |state, dispatch| {
        let types: Vec<&NodeType> = types
            .iter()
            .filter(|ty| ty.spec().attrs.iter().any(|(name, _)| name == attr))
            .collect();
        if types.is_empty() {
            return false;
        }
        if let Some(dispatch) = dispatch {
            let mut tr = state.tr();
            for range in state.selection().ranges() {
                let mut found = Vec::new();
                state
                    .doc()
                    .nodes_between(range.from.pos, range.to.pos, &mut |node, pos, _, _| {
                        if types.contains(&node.ty()) {
                            found.push(pos);
                        }
                        true
                    });
                for pos in found {
                    let _ = tr.set_node_attribute(pos, attr, value.clone());
                }
            }
            dispatch(tr);
        }
        true
    })
}

/// Inserts the default block of the place at `pos` and puts the cursor in
/// it (Tiptap's `insertDefaultBlock`).
pub(crate) fn insert_default_block(
    state: &EditorState,
    pos: usize,
    dispatch: Dispatch<'_>,
) -> bool {
    let Ok(at) = state.doc().resolve(pos) else {
        return false;
    };
    let Some(ty) = at
        .parent()
        .content_match_at(at.index(at.depth))
        .and_then(|m| m.default_type())
        .filter(NodeType::is_textblock)
    else {
        return false;
    };
    let Some(node) = ty.create_and_fill(None, Default::default(), vec![]) else {
        return false;
    };
    if let Some(dispatch) = dispatch {
        let mut tr = state.tr();
        if tr.insert(pos, node.into()).is_err() {
            return false;
        }
        let Ok(inside) = tr.doc().resolve(pos + 1) else {
            return false;
        };
        tr.set_selection(Selection::near(&inside, 1));
        tr.scroll_into_view();
        dispatch(tr);
    }
    true
}
