//! The basic editing commands of `prosemirror-commands`: deleting and
//! joining around block boundaries, splitting, lifting and wrapping
//! blocks, changing block types, toggling marks and selecting, and the
//! base keymap that binds them.

use std::sync::Arc;

use super::{BoxCommand, Dispatch, chain_commands, command};
use crate::rich_editor::{
    model::{
        Attrs, ContentMatch, Fragment, MarkType, Node, NodeType, ResolvedPos, Slice,
        marks_kept_on_split,
    },
    state::{
        AllSelection, EditorState, NodeSelection, Selection, SelectionRange, TextSelection,
        Transaction,
    },
    transform::{
        ReplaceAroundStep, ReplaceStep, can_join, can_split, find_wrapping, join_point,
        lift_target, replace_step,
    },
};

// Hands `tr` to the dispatch (scrolled into view), if there is one. The
// helpers take the dispatch by reference so that a command can try
// several of them.
pub(super) fn send(dispatch: &mut Dispatch<'_>, mut tr: Transaction) {
    if let Some(dispatch) = dispatch.as_deref_mut() {
        tr.scroll_into_view();
        dispatch(tr);
    }
}

pub(super) fn resolve(doc: &Node, pos: usize) -> ResolvedPos {
    doc.resolve(pos).expect("a position inside the document")
}

// ProseMirror's `$pos.after(depth)` also takes `depth + 1`, the position
// itself.
fn after_or_pos(pos: &ResolvedPos, depth: usize) -> usize {
    if depth > pos.depth {
        pos.pos
    } else {
        pos.after(depth)
    }
}

/// Deletes the selection, if it is not empty.
pub fn delete_selection(state: &EditorState, mut dispatch: Dispatch<'_>) -> bool {
    if state.selection().empty() {
        return false;
    }
    if dispatch.is_some() {
        let mut tr = state.tr();
        tr.delete_selection();
        send(&mut dispatch, tr);
    }
    true
}

// The cursor, when it is at the start of its textblock.
fn at_block_start(state: &EditorState) -> Option<ResolvedPos> {
    let selection = state.selection();
    let cursor = selection.cursor()?;
    (cursor.parent_offset == 0).then(|| cursor.clone())
}

// The cursor, when it is at the end of its textblock.
fn at_block_end(state: &EditorState) -> Option<ResolvedPos> {
    let selection = state.selection();
    let cursor = selection.cursor()?;
    (cursor.parent_offset >= cursor.parent().content().size()).then(|| cursor.clone())
}

// Lifts the block range around `pos` out of its parent, when it can be.
fn lift_around(state: &EditorState, pos: &ResolvedPos, dispatch: &mut Dispatch<'_>) -> bool {
    let Some(range) = pos.block_range(pos, None) else {
        return false;
    };
    let Some(target) = lift_target(&range) else {
        return false;
    };
    if dispatch.is_some() {
        let mut tr = state.tr();
        let _ = tr.lift(&range, target);
        send(dispatch, tr);
    }
    true
}

/// At the start of a textblock, joins it with the block before (lifting it
/// out of its parent when there is none before it), or deletes the
/// textblock when it is empty and the node before can take the cursor, or
/// deletes an atom before it.
pub fn join_backward(state: &EditorState, mut dispatch: Dispatch<'_>) -> bool {
    let Some(cursor) = at_block_start(state) else {
        return false;
    };
    let Some(cut) = find_cut_before(&cursor) else {
        return lift_around(state, &cursor, &mut dispatch);
    };
    let Some(before) = cut.node_before() else {
        return false;
    };
    if delete_barrier(state, &cut, &mut dispatch, -1) {
        return true;
    }
    // An empty block after a selectable node or a textblock: delete the
    // empty block (and its parents that hold only it) and select there.
    if cursor.parent().content().size() == 0
        && (textblock_at(&before, Side::End, false) || NodeSelection::is_selectable(&before))
    {
        let mut depth = cursor.depth;
        loop {
            if let Some(step) = replace_step(
                state.doc(),
                cursor.before(depth),
                cursor.after(depth),
                &Slice::empty(),
            ) {
                let deletes = step
                    .as_any()
                    .downcast_ref::<ReplaceStep>()
                    .is_some_and(|step| step.slice.size() < step.to - step.from);
                if deletes {
                    if dispatch.is_some() {
                        let mut tr = state.tr();
                        if tr.step(step).is_err() {
                            return false;
                        }
                        let selection = if textblock_at(&before, Side::End, false) {
                            let at = tr.mapping.map(cut.pos, -1);
                            Selection::find_from(&resolve(tr.doc(), at), -1, false)
                        } else {
                            Some(NodeSelection::create(
                                tr.doc(),
                                cut.pos - before.node_size(),
                            ))
                        };
                        if let Some(selection) = selection {
                            tr.set_selection(selection);
                        }
                        send(&mut dispatch, tr);
                    }
                    return true;
                }
            }
            if depth == 1 || cursor.node(depth - 1).child_count() > 1 {
                break;
            }
            depth -= 1;
        }
    }
    // An atom before, a sibling of the cursor's block: delete it.
    if before.is_atom() && cut.depth + 1 == cursor.depth {
        if dispatch.is_some() {
            let mut tr = state.tr();
            let _ = tr.delete(cut.pos - before.node_size(), cut.pos);
            send(&mut dispatch, tr);
        }
        return true;
    }
    false
}

/// At the start of a textblock, joins it with the textblock before it,
/// however deep that one is, and nothing else (no lifting, no deleting).
pub fn join_text_backward(state: &EditorState, mut dispatch: Dispatch<'_>) -> bool {
    let Some(cursor) = at_block_start(state) else {
        return false;
    };
    let Some(cut) = find_cut_before(&cursor) else {
        return false;
    };
    join_textblocks_around(state, &cut, &mut dispatch)
}

/// `prosemirror-commands`' `joinTextblockBackward`: [`join_text_backward`].
pub fn join_textblock_backward(state: &EditorState, dispatch: Dispatch<'_>) -> bool {
    join_text_backward(state, dispatch)
}

/// `prosemirror-commands`' `joinTextblockForward`: [`join_text_forward`].
pub fn join_textblock_forward(state: &EditorState, dispatch: Dispatch<'_>) -> bool {
    join_text_forward(state, dispatch)
}

/// At the end of a textblock, joins it with the textblock after it,
/// however deep that one is, and nothing else.
pub fn join_text_forward(state: &EditorState, mut dispatch: Dispatch<'_>) -> bool {
    let Some(cursor) = at_block_end(state) else {
        return false;
    };
    let Some(cut) = find_cut_after(&cursor) else {
        return false;
    };
    join_textblocks_around(state, &cut, &mut dispatch)
}

fn join_textblocks_around(
    state: &EditorState,
    cut: &ResolvedPos,
    dispatch: &mut Dispatch<'_>,
) -> bool {
    let (Some(before), Some(after)) = (cut.node_before(), cut.node_after()) else {
        return false;
    };
    let mut before_text = before;
    let mut before_pos = cut.pos - 1;
    while !before_text.is_textblock() {
        if before_text.ty().spec().isolating {
            return false;
        }
        let Some(child) = before_text.last_child().cloned() else {
            return false;
        };
        before_text = child;
        before_pos -= 1;
    }
    let mut after_text = after;
    let mut after_pos = cut.pos + 1;
    while !after_text.is_textblock() {
        if after_text.ty().spec().isolating {
            return false;
        }
        let Some(child) = after_text.first_child().cloned() else {
            return false;
        };
        after_text = child;
        after_pos += 1;
    }
    let Some(step) = replace_step(state.doc(), before_pos, after_pos, &Slice::empty()) else {
        return false;
    };
    match step.as_any().downcast_ref::<ReplaceStep>() {
        Some(replace)
            if replace.from == before_pos && replace.slice.size() < after_pos - before_pos => {}
        _ => return false,
    }
    if dispatch.is_some() {
        let mut tr = state.tr();
        if tr.step(step).is_err() {
            return false;
        }
        let selection = TextSelection::create(tr.doc(), before_pos, None);
        tr.set_selection(selection);
        send(dispatch, tr);
    }
    true
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Start,
    End,
}

// Whether a textblock is at the `side` edge of `node` (or is `node`);
// with `only`, every node on the way has one child.
fn textblock_at(node: &Node, side: Side, only: bool) -> bool {
    let mut scan = Some(node.clone());
    while let Some(node) = scan {
        if node.is_textblock() {
            return true;
        }
        if only && node.child_count() != 1 {
            return false;
        }
        scan = match side {
            Side::Start => node.first_child().cloned(),
            Side::End => node.last_child().cloned(),
        };
    }
    false
}

/// At the start of a textblock (or with the cursor where no textblock
/// is), selects the node before it, when that node can be selected.
pub fn select_node_backward(state: &EditorState, mut dispatch: Dispatch<'_>) -> bool {
    let selection = state.selection();
    if !selection.empty() {
        return false;
    }
    let head = selection.resolved_head().clone();
    let cut = if head.parent().is_textblock() {
        if head.parent_offset > 0 {
            return false;
        }
        find_cut_before(&head)
    } else {
        Some(head)
    };
    let Some(cut) = cut else { return false };
    let Some(node) = cut.node_before() else {
        return false;
    };
    if !NodeSelection::is_selectable(&node) {
        return false;
    }
    if dispatch.is_some() {
        let mut tr = state.tr();
        let selection = NodeSelection::create(state.doc(), cut.pos - node.node_size());
        tr.set_selection(selection);
        send(&mut dispatch, tr);
    }
    true
}

// The position before the block that `pos` leaves backward: where its
// ancestor's previous sibling ends (not out of an isolating node).
fn find_cut_before(pos: &ResolvedPos) -> Option<ResolvedPos> {
    if !pos.parent().ty().spec().isolating {
        for depth in (0..pos.depth).rev() {
            if pos.index(depth) > 0 {
                return Some(resolve(pos.doc(), pos.before(depth + 1)));
            }
            if pos.node(depth).ty().spec().isolating {
                break;
            }
        }
    }
    None
}

// The position after the block that `pos` leaves forward.
fn find_cut_after(pos: &ResolvedPos) -> Option<ResolvedPos> {
    if !pos.parent().ty().spec().isolating {
        for depth in (0..pos.depth).rev() {
            let parent = pos.node(depth);
            if pos.index(depth) + 1 < parent.child_count() {
                return Some(resolve(pos.doc(), pos.after(depth + 1)));
            }
            if parent.ty().spec().isolating {
                break;
            }
        }
    }
    None
}

/// At the end of a textblock, joins the block after it into it, or
/// deletes the textblock when it is empty and the node after can take the
/// cursor, or deletes an atom after it.
pub fn join_forward(state: &EditorState, mut dispatch: Dispatch<'_>) -> bool {
    let Some(cursor) = at_block_end(state) else {
        return false;
    };
    let Some(cut) = find_cut_after(&cursor) else {
        return false;
    };
    let Some(after) = cut.node_after() else {
        return false;
    };
    if delete_barrier(state, &cut, &mut dispatch, 1) {
        return true;
    }
    if cursor.parent().content().size() == 0
        && (textblock_at(&after, Side::Start, false) || NodeSelection::is_selectable(&after))
    {
        let depth = cursor.depth;
        if let Some(step) = replace_step(
            state.doc(),
            cursor.before(depth),
            cursor.after(depth),
            &Slice::empty(),
        ) {
            let deletes = step
                .as_any()
                .downcast_ref::<ReplaceStep>()
                .is_some_and(|step| step.slice.size() < step.to - step.from);
            if deletes {
                if dispatch.is_some() {
                    let mut tr = state.tr();
                    if tr.step(step).is_err() {
                        return false;
                    }
                    let at = tr.mapping.map(cut.pos, 1);
                    let selection = if textblock_at(&after, Side::Start, false) {
                        Selection::find_from(&resolve(tr.doc(), at), 1, false)
                    } else {
                        Some(NodeSelection::create(tr.doc(), at))
                    };
                    if let Some(selection) = selection {
                        tr.set_selection(selection);
                    }
                    send(&mut dispatch, tr);
                }
                return true;
            }
        }
    }
    if after.is_atom() && cut.depth + 1 == cursor.depth {
        if dispatch.is_some() {
            let mut tr = state.tr();
            let _ = tr.delete(cut.pos, cut.pos + after.node_size());
            send(&mut dispatch, tr);
        }
        return true;
    }
    false
}

/// At the end of a textblock (or with the cursor where no textblock is),
/// selects the node after it, when that node can be selected.
pub fn select_node_forward(state: &EditorState, mut dispatch: Dispatch<'_>) -> bool {
    let selection = state.selection();
    if !selection.empty() {
        return false;
    }
    let head = selection.resolved_head().clone();
    let cut = if head.parent().is_textblock() {
        if head.parent_offset < head.parent().content().size() {
            return false;
        }
        find_cut_after(&head)
    } else {
        Some(head)
    };
    let Some(cut) = cut else { return false };
    let Some(node) = cut.node_after() else {
        return false;
    };
    if !NodeSelection::is_selectable(&node) {
        return false;
    }
    if dispatch.is_some() {
        let mut tr = state.tr();
        let selection = NodeSelection::create(state.doc(), cut.pos);
        tr.set_selection(selection);
        send(&mut dispatch, tr);
    }
    true
}

/// Joins the selected block (or the innermost joinable block around the
/// selection) with its sibling above.
pub fn join_up(state: &EditorState, mut dispatch: Dispatch<'_>) -> bool {
    let selection = state.selection();
    let node_selected = selection
        .as_node()
        .map(|selection| selection.node().clone());
    let point = if let Some(node) = &node_selected {
        if node.is_textblock() || !can_join(state.doc(), selection.from()) {
            return false;
        }
        selection.from()
    } else {
        match join_point(state.doc(), selection.from(), -1) {
            Some(point) => point,
            None => return false,
        }
    };
    if dispatch.is_some() {
        let mut tr = state.tr();
        if tr.join(point, 1).is_err() {
            return false;
        }
        if node_selected.is_some() {
            let before = resolve(state.doc(), point)
                .node_before()
                .map_or(0, |node| node.node_size());
            let selection = NodeSelection::create(tr.doc(), point - before);
            tr.set_selection(selection);
        }
        send(&mut dispatch, tr);
    }
    true
}

/// Joins the selected block (or the innermost joinable block around the
/// selection) with its sibling below.
pub fn join_down(state: &EditorState, mut dispatch: Dispatch<'_>) -> bool {
    let selection = state.selection();
    let point = if let Some(node) = selection.as_node() {
        if node.node().is_textblock() || !can_join(state.doc(), selection.to()) {
            return false;
        }
        selection.to()
    } else {
        match join_point(state.doc(), selection.to(), 1) {
            Some(point) => point,
            None => return false,
        }
    };
    if dispatch.is_some() {
        let mut tr = state.tr();
        if tr.join(point, 1).is_err() {
            return false;
        }
        send(&mut dispatch, tr);
    }
    true
}

/// Lifts the selected blocks out of their parent, when they can be.
pub fn lift(state: &EditorState, mut dispatch: Dispatch<'_>) -> bool {
    let selection = state.selection();
    let Some(range) = selection
        .resolved_from()
        .block_range(selection.resolved_to(), None)
    else {
        return false;
    };
    let Some(target) = lift_target(&range) else {
        return false;
    };
    if dispatch.is_some() {
        let mut tr = state.tr();
        let _ = tr.lift(&range, target);
        send(&mut dispatch, tr);
    }
    true
}

/// In a code block (a node whose spec has `code`), replaces the selection
/// with a newline.
pub fn newline_in_code(state: &EditorState, mut dispatch: Dispatch<'_>) -> bool {
    let selection = state.selection();
    let head = selection.resolved_head();
    if !head.parent().ty().spec().code || !head.same_parent(selection.resolved_anchor()) {
        return false;
    }
    if dispatch.is_some() {
        let mut tr = state.tr();
        tr.insert_text("\n", None, None);
        send(&mut dispatch, tr);
    }
    true
}

// The first textblock type `content_match` allows that needs no
// attributes.
fn default_block_at(content_match: &ContentMatch) -> Option<NodeType> {
    (0..content_match.edge_count())
        .map(|i| content_match.edge(i).0)
        .find(|ty| ty.is_textblock() && !ty.has_required_attrs())
}

/// In a code block, creates a default block after it and moves the cursor
/// there.
pub fn exit_code(state: &EditorState, mut dispatch: Dispatch<'_>) -> bool {
    let selection = state.selection();
    let head = selection.resolved_head();
    if !head.parent().ty().spec().code || !head.same_parent(selection.resolved_anchor()) {
        return false;
    }
    let above = head.node(head.depth - 1);
    let after = head.index_after(head.depth - 1);
    let Some(ty) = above
        .content_match_at(after)
        .and_then(|m| default_block_at(&m))
    else {
        return false;
    };
    if !above.can_replace_with(after, after, &ty, None) {
        return false;
    }
    if dispatch.is_some() {
        let Some(block) = ty.create_and_fill(None, Fragment::empty(), vec![]) else {
            return false;
        };
        let pos = head.after(head.depth);
        let mut tr = state.tr();
        if tr
            .replace_with(pos, pos, Fragment::from(vec![block]))
            .is_err()
        {
            return false;
        }
        let selection = Selection::near(&resolve(tr.doc(), pos), 1);
        tr.set_selection(selection);
        send(&mut dispatch, tr);
    }
    true
}

/// With a block node selected (not text), creates an empty default
/// textblock before or after it and puts the cursor there.
pub fn create_paragraph_near(state: &EditorState, mut dispatch: Dispatch<'_>) -> bool {
    let selection = state.selection();
    let (from, to) = (selection.resolved_from(), selection.resolved_to());
    if selection.is_all() || from.parent().is_textblock() || to.parent().is_textblock() {
        return false;
    }
    let Some(ty) = to
        .parent()
        .content_match_at(to.index_after(to.depth))
        .and_then(|m| default_block_at(&m))
    else {
        return false;
    };
    if dispatch.is_some() {
        let side = if from.parent_offset == 0 && to.index(to.depth) < to.parent().child_count() {
            from.pos
        } else {
            to.pos
        };
        let Some(block) = ty.create_and_fill(None, Fragment::empty(), vec![]) else {
            return false;
        };
        let mut tr = state.tr();
        if tr.insert(side, Fragment::from(vec![block])).is_err() {
            return false;
        }
        let selection = TextSelection::create(tr.doc(), side + 1, None);
        tr.set_selection(selection);
        send(&mut dispatch, tr);
    }
    true
}

/// With the cursor in an empty textblock, splits its parent there (when it
/// has content after the block) or lifts the block out of its parent.
pub fn lift_empty_block(state: &EditorState, mut dispatch: Dispatch<'_>) -> bool {
    let selection = state.selection();
    let Some(cursor) = selection.cursor() else {
        return false;
    };
    if cursor.parent().content().size() > 0 {
        return false;
    }
    if cursor.depth > 1 && cursor.after(cursor.depth) != cursor.end(cursor.depth - 1) {
        let before = cursor.before(cursor.depth);
        if can_split(state.doc(), before, 1, None) {
            if dispatch.is_some() {
                let mut tr = state.tr();
                if tr.split(before, 1, None).is_err() {
                    return false;
                }
                send(&mut dispatch, tr);
            }
            return true;
        }
    }
    lift_around(state, cursor, &mut dispatch)
}

/// What [`split_block_as`] makes of the block after a split: given the
/// block split, whether the split is at its end and where it starts, the
/// type (and attributes) of the new block, `None` for the default.
pub type SplitAs =
    Arc<dyn Fn(&Node, bool, &ResolvedPos) -> Option<(NodeType, Option<Attrs>)> + Send + Sync>;

/// Splits the parent block of the selection (deleting the selection
/// first); `split_as` picks the type of the block after the split. At the
/// end of a block, the new block is the parent's default textblock.
pub fn split_block_as(split_as: Option<SplitAs>) -> BoxCommand {
    command(move |state, mut dispatch| split_block_with(state, &mut dispatch, split_as.as_ref()))
}

fn split_block_with(
    state: &EditorState,
    dispatch: &mut Dispatch<'_>,
    split_as: Option<&SplitAs>,
) -> bool {
    let selection = state.selection();
    let from = selection.resolved_from().clone();
    let to = selection.resolved_to().clone();
    if let Some(node) = selection.as_node()
        && node.node().is_block()
    {
        if from.parent_offset == 0 || !can_split(state.doc(), from.pos, 1, None) {
            return false;
        }
        if dispatch.is_some() {
            let mut tr = state.tr();
            if tr.split(from.pos, 1, None).is_err() {
                return false;
            }
            send(dispatch, tr);
        }
        return true;
    }
    if from.depth == 0 {
        return false;
    }
    let mut types: Vec<Option<(NodeType, Option<Attrs>)>> = Vec::new();
    let mut depth = from.depth;
    let (split_depth, default_ty, at_end, at_start, new_attrs) = loop {
        let node = from.node(depth);
        if node.is_block() {
            // Tiptap's getSplittedAttributes: what the new block keeps.
            let new_attrs = node.ty().split_attrs(node.attrs());
            let at_end = from.end(depth) == from.pos + (from.depth - depth);
            let at_start = from.start(depth) == from.pos - (from.depth - depth);
            let default_ty = from
                .node(depth - 1)
                .content_match_at(from.index_after(depth - 1))
                .and_then(|m| default_block_at(&m));
            let split_ty =
                split_as.and_then(|split_as| split_as(&to.parent().clone(), at_end, &from));
            let ty = split_ty.or_else(|| {
                if at_end {
                    default_ty.clone().map(|ty| (ty, Some(new_attrs.clone())))
                } else {
                    None
                }
            });
            types.insert(0, ty);
            break (depth, default_ty, at_end, at_start, new_attrs);
        }
        if depth == 1 {
            return false;
        }
        types.insert(0, None);
        depth -= 1;
    };
    let mut tr = state.tr();
    if selection.as_text().is_some() || selection.is_all() {
        tr.delete_selection();
    }
    let split_pos = tr.mapping.map(from.pos, 1);
    let mut can = can_split(tr.doc(), split_pos, types.len(), Some(&types));
    if !can {
        types[0] = default_ty.clone().map(|ty| (ty, Some(new_attrs.clone())));
        can = can_split(tr.doc(), split_pos, types.len(), Some(&types));
    }
    if !can {
        return false;
    }
    if tr
        .split(split_pos, types.len(), Some(types.clone()))
        .is_err()
    {
        return false;
    }
    // Splitting at the start of a block leaves an empty block of its type
    // before; make that one the default textblock instead.
    if !at_end && at_start && Some(from.node(split_depth).ty()) != default_ty.as_ref() {
        let first = tr.mapping.map(from.before(split_depth), 1);
        let first_pos = resolve(tr.doc(), first);
        if let Some(default_ty) = &default_ty
            && from.node(split_depth - 1).can_replace_with(
                first_pos.index(first_pos.depth),
                first_pos.index(first_pos.depth) + 1,
                default_ty,
                None,
            )
        {
            let _ = tr.set_node_markup(first, Some(default_ty.clone()), None, None);
        }
    }
    send(dispatch, tr);
    true
}

/// Splits the parent block of the selection, as [`split_block_as`]
/// without a type picker.
pub fn split_block(state: &EditorState, mut dispatch: Dispatch<'_>) -> bool {
    split_block_with(state, &mut dispatch, None)
}

/// [`split_block`], keeping the marks at the cursor (or the stored marks)
/// for the text typed in the new block.
pub fn split_block_keep_marks(state: &EditorState, dispatch: Dispatch<'_>) -> bool {
    let Some(dispatch) = dispatch else {
        return split_block(state, None);
    };
    let marks = state.stored_marks().map(<[_]>::to_vec).or_else(|| {
        let selection = state.selection();
        (selection.resolved_to().parent_offset > 0).then(|| selection.resolved_from().marks())
    });
    let mut keep = |mut tr: Transaction| {
        if let Some(marks) = &marks {
            tr.ensure_marks(marks_kept_on_split(marks));
        }
        dispatch(tr);
    };
    split_block(state, Some(&mut keep))
}

/// Selects the innermost node around the selection (that is not the
/// document).
pub fn select_parent_node(state: &EditorState, dispatch: Dispatch<'_>) -> bool {
    let selection = state.selection();
    let from = selection.resolved_from();
    let same = from.shared_depth(selection.to());
    if same == 0 {
        return false;
    }
    if dispatch.is_some() {
        let mut tr = state.tr();
        let selection = NodeSelection::create(state.doc(), from.before(same));
        tr.set_selection(selection);
        if let Some(dispatch) = dispatch {
            dispatch(tr);
        }
    }
    true
}

/// Selects the whole document.
pub fn select_all(state: &EditorState, dispatch: Dispatch<'_>) -> bool {
    if let Some(dispatch) = dispatch {
        let mut tr = state.tr();
        tr.set_selection(AllSelection::new(state.doc()).into());
        dispatch(tr);
    }
    true
}

fn select_textblock_side(state: &EditorState, dispatch: Dispatch<'_>, side: Side) -> bool {
    let selection = state.selection();
    let pos = if side == Side::Start {
        selection.resolved_from()
    } else {
        selection.resolved_to()
    };
    let mut depth = pos.depth;
    while pos.node(depth).is_inline() {
        if depth == 0 {
            return false;
        }
        depth -= 1;
    }
    if !pos.node(depth).is_textblock() {
        return false;
    }
    if let Some(dispatch) = dispatch {
        let at = if side == Side::Start {
            pos.start(depth)
        } else {
            pos.end(depth)
        };
        let mut tr = state.tr();
        tr.set_selection(TextSelection::create(state.doc(), at, None));
        dispatch(tr);
    }
    true
}

/// Moves the cursor to the start of its textblock.
pub fn select_textblock_start(state: &EditorState, dispatch: Dispatch<'_>) -> bool {
    select_textblock_side(state, dispatch, Side::Start)
}

/// Moves the cursor to the end of its textblock.
pub fn select_textblock_end(state: &EditorState, dispatch: Dispatch<'_>) -> bool {
    select_textblock_side(state, dispatch, Side::End)
}

/// Wraps the selected blocks in a node of `ty` (with `attrs`), adding the
/// nodes the schema needs between.
pub fn wrap_in(ty: NodeType, attrs: Option<Attrs>) -> BoxCommand {
    command(move |state, mut dispatch| {
        let selection = state.selection();
        let Some(range) = selection
            .resolved_from()
            .block_range(selection.resolved_to(), None)
        else {
            return false;
        };
        let Some(wrapping) = find_wrapping(&range, &ty, attrs.clone(), None) else {
            return false;
        };
        if dispatch.is_some() {
            let mut tr = state.tr();
            if tr.wrap(&range, &wrapping).is_err() {
                return false;
            }
            send(&mut dispatch, tr);
        }
        true
    })
}

/// Turns the selected textblocks into nodes of `ty` (with `attrs`), where
/// their parents allow it.
pub fn set_block_type(ty: NodeType, attrs: Option<Attrs>) -> BoxCommand {
    command(move |state, mut dispatch| {
        let selection = state.selection();
        let mut applicable = false;
        for range in selection.ranges() {
            if applicable {
                break;
            }
            state
                .doc()
                .nodes_between(range.from.pos, range.to.pos, &mut |node, pos, _, _| {
                    if applicable {
                        return false;
                    }
                    if !node.is_textblock() || node.has_markup(&ty, attrs.as_ref(), None) {
                        return true;
                    }
                    if node.ty() == &ty {
                        applicable = true;
                    } else {
                        let at = resolve(state.doc(), pos);
                        let index = at.index(at.depth);
                        applicable = at.parent().can_replace_with(index, index + 1, &ty, None);
                    }
                    true
                });
        }
        if !applicable {
            return false;
        }
        if dispatch.is_some() {
            let mut tr = state.tr();
            for range in selection.ranges() {
                let _ = tr.set_block_type(range.from.pos, range.to.pos, &ty, attrs.clone());
            }
            send(&mut dispatch, tr);
        }
        true
    })
}

// Whether a mark of `ty` can be added somewhere in the ranges; without
// `enter_atoms`, inline atoms the ranges cover are not looked into.
fn mark_applies(doc: &Node, ranges: &[SelectionRange], ty: &MarkType, enter_atoms: bool) -> bool {
    for range in ranges {
        let (from, to) = (range.from.pos, range.to.pos);
        let mut can =
            range.from.depth == 0 && doc.inline_content() && doc.ty().allows_mark_type(ty);
        doc.nodes_between(from, to, &mut |node, pos, _, _| {
            if can
                || (!enter_atoms
                    && node.is_atom()
                    && node.is_inline()
                    && pos >= from
                    && pos + node.node_size() <= to)
            {
                return false;
            }
            can = node.inline_content() && node.ty().allows_mark_type(ty);
            true
        });
        if can {
            return true;
        }
    }
    false
}

// The ranges without the content of the inline atoms they cover.
fn remove_inline_atoms(ranges: &[SelectionRange]) -> Vec<SelectionRange> {
    let mut result = Vec::new();
    for range in ranges {
        let doc = range.from.doc().clone();
        let mut from = range.from.clone();
        let to = range.to.clone();
        doc.nodes_between(range.from.pos, to.pos, &mut |node, pos, _, _| {
            if node.is_atom()
                && node.content().size() > 0
                && node.is_inline()
                && pos >= from.pos
                && pos + node.node_size() <= to.pos
            {
                if pos + 1 > from.pos {
                    result.push(SelectionRange::new(from.clone(), resolve(&doc, pos + 1)));
                }
                from = resolve(&doc, pos + 1 + node.content().size());
                return false;
            }
            true
        });
        if from.pos < to.pos {
            result.push(SelectionRange::new(from, to));
        }
    }
    result
}

// The UTF-16 lengths of the white space `text` starts and ends with.
fn space_around(text: &str) -> (usize, usize) {
    let start = text
        .chars()
        .take_while(|c| c.is_whitespace())
        .map(char::len_utf16)
        .sum();
    let end = text
        .chars()
        .rev()
        .take_while(|c| c.is_whitespace())
        .map(char::len_utf16)
        .sum();
    (start, end)
}

/// How [`toggle_mark_with`] toggles, after `prosemirror-commands`'
/// `toggleMark` options.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct ToggleMarkOptions {
    /// Removes the mark when any of the selection has it (the default);
    /// otherwise adds it unless all of the selection has it.
    pub remove_when_present: bool,
    /// Also toggles the mark in the content of inline atoms the selection
    /// covers (default true).
    pub enter_inline_atoms: bool,
    /// Gives the white space at the edges of a range the mark too
    /// (default false).
    pub include_whitespace: bool,
}

impl Default for ToggleMarkOptions {
    fn default() -> Self {
        Self {
            remove_when_present: true,
            enter_inline_atoms: true,
            include_whitespace: false,
        }
    }
}

/// Adds a mark of `mark_type` (with `attrs`) to the selection, or removes
/// it where present; [`toggle_mark_with`] with `remove_when_present` and
/// the other options' defaults.
pub fn toggle_mark(
    mark_type: MarkType,
    attrs: Option<Attrs>,
    remove_when_present: bool,
) -> BoxCommand {
    toggle_mark_with(
        mark_type,
        attrs,
        ToggleMarkOptions {
            remove_when_present,
            ..Default::default()
        },
    )
}

/// Adds a mark of `mark_type` (with `attrs`) to the selection, or removes
/// it, as `options` say. With an empty selection it toggles the stored
/// marks, which the next typed text takes.
pub fn toggle_mark_with(
    mark_type: MarkType,
    attrs: Option<Attrs>,
    options: ToggleMarkOptions,
) -> BoxCommand {
    command(move |state, mut dispatch| {
        let selection = state.selection();
        let cursor = selection.cursor().cloned();
        if (selection.empty() && cursor.is_none())
            || !mark_applies(
                state.doc(),
                selection.ranges(),
                &mark_type,
                options.enter_inline_atoms,
            )
        {
            return false;
        }
        let Some(dispatch) = dispatch.as_deref_mut() else {
            return true;
        };
        let Ok(mark) = mark_type.create(attrs.clone()) else {
            return false;
        };
        let mut tr = state.tr();
        if let Some(cursor) = cursor {
            let marks = match state.stored_marks() {
                Some(marks) => marks.to_vec(),
                None => cursor.marks(),
            };
            if mark_type.is_in_set(&marks).is_some() {
                tr.remove_stored_mark_type(&mark_type);
            } else {
                tr.add_stored_mark(&mark);
            }
            dispatch(tr);
            return true;
        }
        let ranges = if options.enter_inline_atoms {
            selection.ranges().to_vec()
        } else {
            remove_inline_atoms(selection.ranges())
        };
        let add = if options.remove_when_present {
            !ranges
                .iter()
                .any(|r| state.doc().range_has_mark(r.from.pos, r.to.pos, &mark_type))
        } else {
            !ranges.iter().all(|r| {
                let mut missing = false;
                state
                    .doc()
                    .nodes_between(r.from.pos, r.to.pos, &mut |node, pos, parent, _| {
                        if missing {
                            return false;
                        }
                        let blank = node.is_text() && {
                            let from = r.from.pos.saturating_sub(pos);
                            let to = (r.to.pos - pos).min(node.node_size());
                            node.text_between(from, to, None, None).trim().is_empty()
                        };
                        missing = mark_type.is_in_set(node.marks()).is_none()
                            && parent
                                .is_some_and(|parent| parent.ty().allows_mark_type(&mark_type))
                            && !blank;
                        true
                    });
                !missing
            })
        };
        for range in &ranges {
            if add {
                let (mut from, mut to) = (range.from.pos, range.to.pos);
                if !options.include_whitespace {
                    let space_start = range
                        .from
                        .node_after()
                        .and_then(|node| node.text().map(|text| space_around(text).0))
                        .unwrap_or(0);
                    let space_end = range
                        .to
                        .node_before()
                        .and_then(|node| node.text().map(|text| space_around(text).1))
                        .unwrap_or(0);
                    if from + space_start < to {
                        from += space_start;
                        to -= space_end;
                    }
                }
                let _ = tr.add_mark(from, to, mark.clone());
            } else {
                let _ = tr.remove_mark(range.from.pos, range.to.pos, mark_type.clone().into());
            }
        }
        tr.scroll_into_view();
        dispatch(tr);
        true
    })
}

/// Whether `auto_join` joins two adjacent nodes.
pub type IsJoinable = Arc<dyn Fn(&Node, &Node) -> bool + Send + Sync>;

/// Wraps `inner` so that its transactions also join the nodes they leave
/// next to each other that `is_joinable` accepts (two lists of one kind
/// after a wrap, say).
pub fn auto_join(inner: BoxCommand, is_joinable: IsJoinable) -> BoxCommand {
    command(move |state, dispatch| {
        let Some(dispatch) = dispatch else {
            return inner(state, None);
        };
        let mut joining = |mut tr: Transaction| {
            if tr.is_generic() {
                join_adjacent(&mut tr, is_joinable.as_ref());
            }
            dispatch(tr);
        };
        inner(state, Some(&mut joining))
    })
}

fn join_adjacent(tr: &mut Transaction, is_joinable: &(dyn Fn(&Node, &Node) -> bool + Send + Sync)) {
    // The ranges the steps touched, in the final document.
    let mut ranges: Vec<usize> = Vec::new();
    for map in &tr.mapping.maps {
        for pos in ranges.iter_mut() {
            *pos = map.map(*pos, 1);
        }
        map.for_each(|_, _, from, to| {
            ranges.push(from);
            ranges.push(to);
        });
    }
    let mut joinable: Vec<usize> = Vec::new();
    for pair in ranges.chunks(2) {
        let (from, to) = (pair[0], pair[1]);
        let start = resolve(tr.doc(), from);
        let depth = start.shared_depth(to);
        let parent = start.node(depth).clone();
        let mut index = start.index_after(depth);
        let mut pos = after_or_pos(&start, depth + 1);
        while pos <= to {
            let Some(after) = parent.maybe_child(index).cloned() else {
                break;
            };
            if index > 0 && !joinable.contains(&pos) {
                let before = parent.child(index - 1);
                if before.ty() == after.ty() && is_joinable(before, &after) {
                    joinable.push(pos);
                }
            }
            pos += after.node_size();
            index += 1;
        }
    }
    joinable.sort_unstable();
    for &pos in joinable.iter().rev() {
        if can_join(tr.doc(), pos) {
            let _ = tr.join(pos, 1);
        }
    }
}

fn join_maybe_clear(state: &EditorState, pos: &ResolvedPos, dispatch: &mut Dispatch<'_>) -> bool {
    let (Some(before), Some(after)) = (pos.node_before(), pos.node_after()) else {
        return false;
    };
    let index = pos.index(pos.depth);
    if !before.ty().compatible_content(after.ty()) {
        return false;
    }
    if before.content().size() == 0
        && pos
            .parent()
            .can_replace(index - 1, index, &Fragment::empty(), 0, 0)
    {
        if dispatch.is_some() {
            let mut tr = state.tr();
            let _ = tr.delete(pos.pos - before.node_size(), pos.pos);
            send(dispatch, tr);
        }
        return true;
    }
    if !pos
        .parent()
        .can_replace(index, index + 1, &Fragment::empty(), 0, 0)
        || !(after.is_textblock() || can_join(state.doc(), pos.pos))
    {
        return false;
    }
    if dispatch.is_some() {
        let mut tr = state.tr();
        if tr.join(pos.pos, 1).is_err() {
            return false;
        }
        send(dispatch, tr);
    }
    true
}

// Deletes the boundary at `cut` between two blocks: joins them, wraps
// the block after into the one before, lifts it, or moves the content of
// a textblock after into the textblock before.
fn delete_barrier(
    state: &EditorState,
    cut: &ResolvedPos,
    dispatch: &mut Dispatch<'_>,
    dir: i32,
) -> bool {
    let (Some(before), Some(after)) = (cut.node_before(), cut.node_after()) else {
        return false;
    };
    let isolated = before.ty().spec().isolating || after.ty().spec().isolating;
    if !isolated && join_maybe_clear(state, cut, dispatch) {
        return true;
    }

    let index = cut.index(cut.depth);
    let can_del_after = !isolated
        && cut
            .parent()
            .can_replace(index, index + 1, &Fragment::empty(), 0, 0);
    if can_del_after {
        let content_match = before.content_match_at(before.child_count());
        if let Some((content_match, conn)) =
            content_match.and_then(|m| m.find_wrapping(after.ty()).map(|conn| (m, conn)))
        {
            let first = conn.first().unwrap_or(after.ty()).clone();
            if content_match
                .match_type(&first)
                .is_some_and(|m| m.valid_end())
            {
                if dispatch.is_some() {
                    let end = cut.pos + after.node_size();
                    let mut wrap = Fragment::empty();
                    for ty in conn.iter().rev() {
                        match ty.create(None, wrap, vec![]) {
                            Ok(node) => wrap = Fragment::from(vec![node]),
                            Err(_) => return false,
                        }
                    }
                    let wrap = Fragment::from(vec![before.copy(wrap)]);
                    let mut tr = state.tr();
                    let step = ReplaceAroundStep::new(
                        cut.pos - 1,
                        end,
                        cut.pos,
                        end,
                        Slice::new(wrap, 1, 0),
                        conn.len(),
                        true,
                    );
                    if tr.step(Box::new(step)).is_err() {
                        return false;
                    }
                    let join_at = resolve(tr.doc(), end + 2 * conn.len());
                    if join_at
                        .node_after()
                        .is_some_and(|node| node.ty() == before.ty())
                        && can_join(tr.doc(), join_at.pos)
                    {
                        let _ = tr.join(join_at.pos, 1);
                    }
                    send(dispatch, tr);
                }
                return true;
            }
        }
    }

    let sel_after = if after.ty().spec().isolating || (dir > 0 && isolated) {
        None
    } else {
        Selection::find_from(cut, 1, false)
    };
    if let Some(sel_after) = sel_after
        && let Some(range) = sel_after
            .resolved_from()
            .block_range(sel_after.resolved_to(), None)
        && let Some(target) = lift_target(&range)
        && target >= cut.depth
    {
        if dispatch.is_some() {
            let mut tr = state.tr();
            let _ = tr.lift(&range, target);
            send(dispatch, tr);
        }
        return true;
    }

    if can_del_after
        && textblock_at(&after, Side::Start, true)
        && textblock_at(&before, Side::End, false)
    {
        let mut at = before.clone();
        let mut wrap = Vec::new();
        loop {
            wrap.push(at.clone());
            if at.is_textblock() {
                break;
            }
            let Some(last) = at.last_child().cloned() else {
                return false;
            };
            at = last;
        }
        let mut after_text = after.clone();
        let mut after_depth = 1;
        while !after_text.is_textblock() {
            let Some(first) = after_text.first_child().cloned() else {
                return false;
            };
            after_text = first;
            after_depth += 1;
        }
        let content = after_text.content();
        if at.can_replace(
            at.child_count(),
            at.child_count(),
            content,
            0,
            content.child_count(),
        ) {
            if dispatch.is_some() {
                let mut end = Fragment::empty();
                for node in wrap.iter().rev() {
                    end = Fragment::from(vec![node.copy(end)]);
                }
                let mut tr = state.tr();
                let step = ReplaceAroundStep::new(
                    cut.pos - wrap.len(),
                    cut.pos + after.node_size(),
                    cut.pos + after_depth,
                    cut.pos + after.node_size() - after_depth,
                    Slice::new(end, wrap.len(), 0),
                    0,
                    true,
                );
                if tr.step(Box::new(step)).is_err() {
                    return false;
                }
                send(dispatch, tr);
            }
            return true;
        }
    }
    false
}

fn backspace() -> BoxCommand {
    chain_commands(vec![
        command(delete_selection),
        command(join_backward),
        command(select_node_backward),
    ])
}

fn delete() -> BoxCommand {
    chain_commands(vec![
        command(delete_selection),
        command(join_forward),
        command(select_node_forward),
    ])
}

/// The base key bindings off Apple platforms: Enter splits (or leaves code
/// and empty blocks), Backspace and Delete delete and join, `Mod-a`
/// selects all.
pub fn pc_base_keymap() -> Vec<(String, BoxCommand)> {
    let enter = chain_commands(vec![
        command(newline_in_code),
        command(create_paragraph_near),
        command(lift_empty_block),
        command(split_block),
    ]);
    let backspace = backspace();
    let delete = delete();
    vec![
        ("Enter".into(), enter),
        ("Mod-Enter".into(), command(exit_code)),
        ("Backspace".into(), backspace.clone()),
        ("Mod-Backspace".into(), backspace.clone()),
        ("Shift-Backspace".into(), backspace),
        ("Delete".into(), delete.clone()),
        ("Mod-Delete".into(), delete),
        ("Mod-a".into(), command(select_all)),
    ]
}

/// The base key bindings on Apple platforms: [`pc_base_keymap`]'s and the
/// Emacs-style ones macOS text fields have (`Ctrl-h`, `Ctrl-d`, `Ctrl-a`,
/// `Ctrl-e`, ...).
pub fn mac_base_keymap() -> Vec<(String, BoxCommand)> {
    let backspace = backspace();
    let delete = delete();
    let mut keymap = pc_base_keymap();
    keymap.extend([
        ("Ctrl-h".into(), backspace.clone()),
        ("Alt-Backspace".into(), backspace),
        ("Ctrl-d".into(), delete.clone()),
        ("Ctrl-Alt-Backspace".into(), delete.clone()),
        ("Alt-Delete".into(), delete.clone()),
        ("Alt-d".into(), delete),
        ("Ctrl-a".into(), command(select_textblock_start)),
        ("Ctrl-e".into(), command(select_textblock_end)),
    ]);
    keymap
}

/// The base key bindings of this platform: [`mac_base_keymap`] on macOS
/// and iOS, [`pc_base_keymap`] elsewhere.
pub fn base_keymap() -> Vec<(String, BoxCommand)> {
    if cfg!(any(target_os = "macos", target_os = "ios")) {
        mac_base_keymap()
    } else {
        pc_base_keymap()
    }
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::{super::test_util::*, *};

    #[test]
    fn toggle_mark_on_a_range_and_back() {
        let s = schema();
        let doc = n(&s, "doc", vec![p(&s, "hello world")]);
        let bold = s.mark_type("bold").unwrap();
        let toggle = toggle_mark(bold.clone(), None, true);
        let on = apply(&state(doc.clone(), 1, 6), toggle.as_ref()).unwrap();
        assert!(on.doc().range_has_mark(1, 6, &bold));
        assert!(!on.doc().range_has_mark(6, 12, &bold));
        let off = apply(&on, toggle.as_ref()).unwrap();
        assert!(off.doc().eq(&doc));
    }

    #[test]
    fn toggle_mark_skips_edge_white_space() {
        let s = schema();
        let doc = n(&s, "doc", vec![p(&s, " ab ")]);
        let bold = s.mark_type("bold").unwrap();
        let on = apply(
            &state(doc, 1, 5),
            toggle_mark(bold.clone(), None, true).as_ref(),
        )
        .unwrap();
        assert!(on.doc().range_has_mark(2, 4, &bold));
        assert!(!on.doc().range_has_mark(1, 2, &bold));
        assert!(!on.doc().range_has_mark(4, 5, &bold));
    }

    #[test]
    fn toggle_mark_at_a_cursor_sets_stored_marks() {
        let s = schema();
        let doc = n(&s, "doc", vec![p(&s, "ab")]);
        let bold = s.mark_type("bold").unwrap();
        let toggle = toggle_mark(bold.clone(), None, true);
        let on = apply(&state(doc.clone(), 2, 2), toggle.as_ref()).unwrap();
        assert!(on.doc().eq(&doc), "the document is unchanged");
        let stored = on.stored_marks().expect("stored marks");
        assert!(bold.is_in_set(stored).is_some());
        assert!(crate::rich_editor::commands::is_mark_active(&on, &bold));
        let off = apply(&on, toggle.as_ref()).unwrap();
        assert!(
            off.stored_marks()
                .is_none_or(|marks| bold.is_in_set(marks).is_none())
        );
        // Not where marks are not allowed: a code block.
        let code = n(&s, "doc", vec![n(&s, "codeBlock", vec![t(&s, "x")])]);
        assert!(apply(&state(code, 2, 2), toggle.as_ref()).is_none());
    }

    #[test]
    fn split_block_splits_and_makes_a_paragraph_after_a_heading() {
        let s = schema();
        let doc = n(&s, "doc", vec![p(&s, "abcd")]);
        let split = apply(&state(doc, 3, 3), &split_block).unwrap();
        assert_eq!(split.doc().child_count(), 2);
        assert_eq!(split.doc().child(0).text_content(), "ab");
        assert_eq!(split.doc().child(1).text_content(), "cd");
        assert_eq!(split.selection().from(), 5);

        let heading = n(&s, "doc", vec![n(&s, "heading", vec![t(&s, "title")])]);
        let after = apply(&state(heading, 6, 6), &split_block).unwrap();
        assert_eq!(after.doc().child(0).ty().name(), "heading");
        assert_eq!(after.doc().child(1).ty().name(), "paragraph");
    }

    #[test]
    fn join_backward_joins_textblocks_and_lifts() {
        let s = schema();
        let doc = n(&s, "doc", vec![p(&s, "ab"), p(&s, "cd")]);
        let joined = apply(&state(doc.clone(), 5, 5), &join_backward).unwrap();
        assert_eq!(joined.doc().child_count(), 1);
        assert_eq!(joined.doc().child(0).text_content(), "abcd");
        assert_eq!(joined.selection().from(), 3);
        // Not inside a block.
        assert!(apply(&state(doc.clone(), 6, 6), &join_backward).is_none());
        // At the start of the document there is nothing to join.
        assert!(apply(&state(doc, 1, 1), &join_backward).is_none());
        // The first block of a quote is lifted out of it.
        let quote = n(&s, "doc", vec![n(&s, "blockquote", vec![p(&s, "q")])]);
        let lifted = apply(&state(quote, 2, 2), &join_backward).unwrap();
        assert_eq!(lifted.doc().child(0).ty().name(), "paragraph");
    }

    #[test]
    fn chain_runs_until_one_applies() {
        let s = schema();
        let doc = n(&s, "doc", vec![p(&s, "ab"), p(&s, "cd")]);
        let backspace = chain_commands(vec![command(delete_selection), command(join_backward)]);
        let joined = apply(&state(doc, 5, 5), backspace.as_ref()).unwrap();
        assert_eq!(joined.doc().child_count(), 1);
    }

    #[test]
    fn set_block_type_and_wrap_in() {
        let s = schema();
        let doc = n(&s, "doc", vec![p(&s, "ab")]);
        let mut level = Attrs::new();
        level.insert("level".into(), 2.into());
        // All its attributes, as `has_markup` compares them whole (PM).
        level.insert("textAlign".into(), serde_json::Value::Null);
        let heading = s.node_type("heading").unwrap();
        let set = set_block_type(heading.clone(), Some(level));
        let changed = apply(&state(doc.clone(), 2, 2), set.as_ref()).unwrap();
        assert_eq!(changed.doc().child(0).ty(), &heading);
        assert!(apply(&changed, set.as_ref()).is_none(), "already that type");
        let quote = wrap_in(s.node_type("blockquote").unwrap(), None);
        let wrapped = apply(&state(doc, 2, 2), quote.as_ref()).unwrap();
        assert_eq!(wrapped.doc().child(0).ty().name(), "blockquote");
    }

    // The starter schema whose paragraphs and list items have an `id` not
    // kept on split and an `align` kept, and whose links are not kept.
    fn split_schema() -> crate::rich_editor::model::Schema {
        use crate::rich_editor::model::{AttrSpec, Schema};
        let mut spec = crate::rich_editor::extensions::starter::schema_spec();
        for (name, node) in spec.nodes.iter_mut() {
            if name == "paragraph" || name == "listItem" {
                let mut id = AttrSpec::default();
                id.default = Some(serde_json::Value::Null);
                id.keep_on_split = false;
                let mut align = AttrSpec::default();
                align.default = Some(serde_json::Value::Null);
                node.attrs.push(("id".into(), id));
                node.attrs.push(("align".into(), align));
            }
        }
        for (name, mark) in spec.marks.iter_mut() {
            if name == "link" {
                mark.keep_on_split = false;
            }
        }
        Schema::new(spec).unwrap()
    }

    fn split_attrs_json() -> Attrs {
        [
            ("id".to_owned(), serde_json::json!("x")),
            ("align".to_owned(), serde_json::json!("center")),
        ]
        .into_iter()
        .collect()
    }

    #[test]
    fn split_block_keeps_only_attributes_kept_on_split() {
        let s = split_schema();
        let para = s
            .node(
                "paragraph",
                Some(split_attrs_json()),
                Fragment::from(vec![t(&s, "ab")]),
                vec![],
            )
            .unwrap();
        let doc = n(&s, "doc", vec![para]);
        let out = apply(&state(doc, 3, 3), &split_block).unwrap();
        let second = out.doc().child(1);
        assert_eq!(
            second.attrs().get("align"),
            Some(&serde_json::json!("center"))
        );
        assert_eq!(second.attrs().get("id"), Some(&serde_json::Value::Null));
    }

    #[test]
    fn split_block_keep_marks_drops_marks_not_kept() {
        let s = split_schema();
        let bold = s.mark_type("bold").unwrap().create(None).unwrap();
        let link = s
            .mark_type("link")
            .unwrap()
            .create(Some(
                [("href".to_owned(), serde_json::json!("a"))]
                    .into_iter()
                    .collect(),
            ))
            .unwrap();
        let text = s.text("ab", vec![bold.clone(), link]);
        let doc = n(&s, "doc", vec![n(&s, "paragraph", vec![text])]);
        let out = apply(&state(doc, 3, 3), &split_block_keep_marks).unwrap();
        let stored = out.stored_marks().expect("stored marks");
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].ty().name(), "bold");
    }

    #[test]
    fn split_list_item_gives_the_new_item_split_attributes() {
        let s = split_schema();
        let item_ty = ["listItem"].iter().find_map(|n| s.node_type(n)).unwrap();
        let list_ty = ["bulletList"].iter().find_map(|n| s.node_type(n)).unwrap();
        let item = item_ty
            .create(
                Some(split_attrs_json()),
                Fragment::from(vec![p(&s, "ab")]),
                vec![],
            )
            .unwrap();
        let doc = n(
            &s,
            "doc",
            vec![
                list_ty
                    .create(None, Fragment::from(vec![item]), vec![])
                    .unwrap(),
            ],
        );
        // At the end of "ab" (list 0, item 1, paragraph 2, text 3..5).
        let split = crate::rich_editor::commands::split_list_item(item_ty.clone(), None);
        let out = apply(&state(doc, 5, 5), split.as_ref()).unwrap();
        let second = out.doc().child(0).child(1);
        assert_eq!(
            second.attrs().get("align"),
            Some(&serde_json::json!("center"))
        );
        assert_eq!(second.attrs().get("id"), Some(&serde_json::Value::Null));
    }
}
