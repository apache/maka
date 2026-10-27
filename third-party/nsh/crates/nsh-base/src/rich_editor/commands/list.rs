//! The list commands of `prosemirror-schema-list`: wrapping blocks in a
//! list, splitting a list item, and lifting items out of (or sinking them
//! into) a list. They take the app's list and item types, so any schema's
//! lists work.

use super::{
    BoxCommand, Dispatch,
    base::{resolve, send},
    command,
};
use crate::rich_editor::{
    model::{Attrs, Fragment, Node, NodeRange, NodeType, Slice, marks_kept_on_split},
    state::{EditorState, Selection, Transaction},
    transform::{ReplaceAroundStep, can_join, can_split, find_wrapping, lift_target},
};

/// Wraps the selected blocks in a list of `list_ty` (with `attrs`). At the
/// start of an item that is not the list's first, the blocks join the item
/// before instead (a nested list).
pub fn wrap_in_list(list_ty: NodeType, attrs: Option<Attrs>) -> BoxCommand {
    command(move |state, mut dispatch| {
        let selection = state.selection();
        let Some(range) = selection
            .resolved_from()
            .block_range(selection.resolved_to(), None)
        else {
            return false;
        };
        let mut tr = dispatch.is_some().then(|| state.tr());
        if !wrap_range_in_list(tr.as_mut(), &range, &list_ty, attrs.clone()) {
            return false;
        }
        if let Some(tr) = tr {
            send(&mut dispatch, tr);
        }
        true
    })
}

/// Wraps `range` in a list of `list_ty`, adding the steps to `tr` when
/// given; whether it can be.
pub fn wrap_range_in_list(
    tr: Option<&mut Transaction>,
    range: &NodeRange,
    list_ty: &NodeType,
    attrs: Option<Attrs>,
) -> bool {
    let mut range = range.clone();
    let mut outer_range = range.clone();
    let mut join_before = false;
    let doc = range.from.doc().clone();
    // At the top of an existing list item: wrap into the item before.
    if range.depth >= 2
        && range
            .from
            .node(range.depth - 1)
            .ty()
            .compatible_content(list_ty)
        && range.start_index() == 0
    {
        // The list's first item has no item before.
        if range.from.index(range.depth - 1) == 0 {
            return false;
        }
        let insert = resolve(&doc, range.start() - 2);
        outer_range = NodeRange::new(insert.clone(), insert, range.depth);
        if range.end_index() < range.parent().child_count() {
            let end = resolve(&doc, range.to.end(range.depth));
            range = NodeRange::new(range.from.clone(), end, range.depth);
        }
        join_before = true;
    }
    let Some(wrappers) = find_wrapping(&outer_range, list_ty, attrs, Some(&range)) else {
        return false;
    };
    if let Some(tr) = tr {
        do_wrap_in_list(tr, &range, &wrappers, join_before, list_ty);
    }
    true
}

fn do_wrap_in_list(
    tr: &mut Transaction,
    range: &NodeRange,
    wrappers: &[(NodeType, Option<Attrs>)],
    join_before: bool,
    list_ty: &NodeType,
) {
    let mut content = Fragment::empty();
    for (ty, attrs) in wrappers.iter().rev() {
        match ty.create(attrs.clone(), content, vec![]) {
            Ok(node) => content = Fragment::from(vec![node]),
            Err(_) => return,
        }
    }
    let shift = if join_before { 2 } else { 0 };
    let step = ReplaceAroundStep::new(
        range.start() - shift,
        range.end(),
        range.start(),
        range.end(),
        Slice::new(content, 0, 0),
        wrappers.len(),
        true,
    );
    if tr.step(Box::new(step)).is_err() {
        return;
    }
    // Each wrapped block becomes an item of its own: split between them.
    let found = wrappers
        .iter()
        .rposition(|(ty, _)| ty == list_ty)
        .map_or(0, |i| i + 1);
    let split_depth = wrappers.len() - found;
    let mut split_pos = range.start() + wrappers.len() - shift;
    let parent = range.parent().clone();
    for (n, i) in (range.start_index()..range.end_index()).enumerate() {
        if n > 0 && can_split(tr.doc(), split_pos, split_depth, None) {
            let _ = tr.split(split_pos, split_depth, None);
            split_pos += 2 * split_depth;
        }
        split_pos += parent.child(i).node_size();
    }
}

/// Splits the list item of `item_ty` around the cursor; the new item gets
/// `item_attrs`. In an empty block at the end of a nested item, splits the
/// outer item instead; in an empty block of an outer list it does nothing,
/// so that the next command can lift the item.
pub fn split_list_item(item_ty: NodeType, item_attrs: Option<Attrs>) -> BoxCommand {
    command(move |state, mut dispatch| {
        let selection = state.selection();
        let from = selection.resolved_from().clone();
        let to = selection.resolved_to().clone();
        if selection
            .as_node()
            .is_some_and(|node| node.node().is_block())
            || from.depth < 2
            || !from.same_parent(&to)
        {
            return false;
        }
        let d = from.depth;
        let grand_parent = from.node(d - 1).clone();
        if grand_parent.ty() != &item_ty {
            return false;
        }
        if from.parent().content().size() == 0
            && grand_parent.child_count() == from.index_after(d - 1)
        {
            // An empty last block of an item: in a nested list, split the
            // outer item; otherwise leave it to the lifting command.
            if d == 3
                || from.node(d - 3).ty() != &item_ty
                || from.index(d - 2) != from.node(d - 2).child_count() - 1
            {
                return false;
            }
            if dispatch.is_some() {
                let mut wrap = Fragment::empty();
                let depth_before = if from.index(d - 1) > 0 {
                    1
                } else if from.index(d - 2) > 0 {
                    2
                } else {
                    3
                };
                // Empty copies of the structure from the outer item down to
                // the cursor's parent.
                for depth in (d - 3..=d - depth_before).rev() {
                    wrap = Fragment::from(vec![from.node(depth).copy(wrap)]);
                }
                let depth_after = if from.index_after(d - 1) < from.node(d - 2).child_count() {
                    1
                } else if from.index_after(d - 2) < from.node(d - 3).child_count() {
                    2
                } else {
                    3
                };
                let Some(item) = item_ty.create_and_fill(None, Fragment::empty(), vec![]) else {
                    return false;
                };
                let wrap = wrap.append(&Fragment::from(vec![item]));
                let start = from.before(d - (depth_before - 1));
                let mut tr = state.tr();
                if tr
                    .replace(
                        start,
                        from.after(d - depth_after),
                        Slice::new(wrap, 4 - depth_before, 0),
                    )
                    .is_err()
                {
                    return false;
                }
                let mut sel = None;
                let size = tr.doc().content().size();
                tr.doc()
                    .nodes_between(start, size, &mut |node: &Node, pos, _, _| {
                        if sel.is_some() {
                            return false;
                        }
                        if node.is_textblock() && node.content().size() == 0 {
                            sel = Some(pos + 1);
                        }
                        true
                    });
                if let Some(sel) = sel {
                    let selection = Selection::near(&resolve(tr.doc(), sel), 1);
                    tr.set_selection(selection);
                }
                send(&mut dispatch, tr);
            }
            return true;
        }
        let next_ty = if to.pos == from.end(d) {
            grand_parent
                .content_match_at(0)
                .and_then(|m| m.default_type())
        } else {
            None
        };
        let mut tr = state.tr();
        let _ = tr.delete(from.pos, to.pos);
        // Tiptap's splitListItem: the new item (and the new block at the
        // item's end) get the attributes kept on split, the rest their
        // defaults.
        let item_attrs = item_attrs
            .clone()
            .unwrap_or_else(|| item_ty.split_attrs(grand_parent.attrs()));
        let parent = from.parent();
        let types = Some(vec![
            Some((item_ty.clone(), Some(item_attrs))),
            next_ty.map(|next_ty| (next_ty, Some(parent.ty().split_attrs(parent.attrs())))),
        ]);
        if !can_split(tr.doc(), from.pos, 2, types.as_deref()) {
            return false;
        }
        if dispatch.is_some() {
            if tr.split(from.pos, 2, types).is_err() {
                return false;
            }
            send(&mut dispatch, tr);
        }
        true
    })
}

// The range of list items of `item_ty` around the selection.
fn item_range(state: &EditorState, item_ty: &NodeType) -> Option<NodeRange> {
    let selection = state.selection();
    let is_item_list = |node: &Node| {
        node.child_count() > 0
            && node
                .first_child()
                .is_some_and(|child| child.ty() == item_ty)
    };
    selection
        .resolved_from()
        .block_range(selection.resolved_to(), Some(&is_item_list))
}

/// Lifts the selected list items of `item_ty` out of their list: into the
/// outer list when nested, out of lists otherwise.
pub fn lift_list_item(item_ty: NodeType) -> BoxCommand {
    command(move |state, mut dispatch| {
        let Some(range) = item_range(state, &item_ty) else {
            return false;
        };
        if dispatch.is_none() {
            return true;
        }
        if range.from.node(range.depth - 1).ty() == &item_ty {
            lift_to_outer_list(state, &mut dispatch, &item_ty, range)
        } else {
            lift_out_of_list(state, &mut dispatch, &range)
        }
    })
}

fn lift_to_outer_list(
    state: &EditorState,
    dispatch: &mut Dispatch<'_>,
    item_ty: &NodeType,
    range: NodeRange,
) -> bool {
    let mut tr = state.tr();
    let mut range = range;
    let end = range.end();
    let end_of_list = range.to.end(range.depth);
    if end < end_of_list {
        // Siblings after the lifted items become children of the last one.
        let Ok(item) = item_ty.create(
            None,
            Fragment::from(vec![range.parent().copy(Fragment::empty())]),
            vec![],
        ) else {
            return false;
        };
        let step = ReplaceAroundStep::new(
            end - 1,
            end_of_list,
            end,
            end_of_list,
            Slice::new(Fragment::from(vec![item]), 1, 0),
            1,
            true,
        );
        if tr.step(Box::new(step)).is_err() {
            return false;
        }
        range = NodeRange::new(
            resolve(tr.doc(), range.from.pos),
            resolve(tr.doc(), end_of_list),
            range.depth,
        );
    }
    let Some(target) = lift_target(&range) else {
        return false;
    };
    if tr.lift(&range, target).is_err() {
        return false;
    }
    let after = resolve(tr.doc(), tr.mapping.map(end, -1) - 1);
    if can_join(tr.doc(), after.pos)
        && after.node_before().map(|node| node.ty().clone())
            == after.node_after().map(|node| node.ty().clone())
    {
        let _ = tr.join(after.pos, 1);
    }
    send(dispatch, tr);
    true
}

fn lift_out_of_list(state: &EditorState, dispatch: &mut Dispatch<'_>, range: &NodeRange) -> bool {
    let mut tr = state.tr();
    let list = range.parent().clone();
    // Merge the items into one big item.
    let mut pos = range.end();
    for i in (range.start_index() + 1..range.end_index()).rev() {
        pos -= list.child(i).node_size();
        let _ = tr.delete(pos - 1, pos + 1);
    }
    let start = resolve(tr.doc(), range.start());
    let Some(item) = start.node_after() else {
        return false;
    };
    if tr.mapping.map(range.end(), 1) != range.start() + item.node_size() {
        return false;
    }
    let at_start = range.start_index() == 0;
    let at_end = range.end_index() == list.child_count();
    let parent = start.node(start.depth - 1).clone();
    let index_before = start.index(start.depth - 1);
    let rest = if at_end {
        Fragment::empty()
    } else {
        Fragment::from(vec![list.clone()])
    };
    let replacement = item.content().append(&rest);
    if !parent.can_replace(
        index_before + usize::from(!at_start),
        index_before + 1,
        &replacement,
        0,
        replacement.child_count(),
    ) {
        return false;
    }
    let from = start.pos;
    let end = from + item.node_size();
    // Strip the list around the item: where the item is not at the list's
    // edge, the rest of the list is closed off.
    let empty_list = || Fragment::from(vec![list.copy(Fragment::empty())]);
    let before = if at_start {
        Fragment::empty()
    } else {
        empty_list()
    };
    let after = if at_end {
        Fragment::empty()
    } else {
        empty_list()
    };
    let step = ReplaceAroundStep::new(
        from - usize::from(at_start),
        end + usize::from(at_end),
        from + 1,
        end - 1,
        Slice::new(
            before.append(&after),
            usize::from(!at_start),
            usize::from(!at_end),
        ),
        usize::from(!at_start),
        false,
    );
    if tr.step(Box::new(step)).is_err() {
        return false;
    }
    send(dispatch, tr);
    true
}

/// Sinks the selected list items of `item_ty` into a list nested in the
/// item before them.
pub fn sink_list_item(item_ty: NodeType) -> BoxCommand {
    command(move |state, mut dispatch| {
        let Some(range) = item_range(state, &item_ty) else {
            return false;
        };
        let start_index = range.start_index();
        if start_index == 0 {
            return false;
        }
        let parent = range.parent().clone();
        let node_before = parent.child(start_index - 1);
        if node_before.ty() != &item_ty {
            return false;
        }
        if dispatch.is_some() {
            let nested_before = node_before
                .last_child()
                .is_some_and(|child| child.ty() == parent.ty());
            let inner = if nested_before {
                match item_ty.create(None, Fragment::empty(), vec![]) {
                    Ok(item) => Fragment::from(vec![item]),
                    Err(_) => return false,
                }
            } else {
                Fragment::empty()
            };
            let Ok(list) = parent.ty().create(None, inner, vec![]) else {
                return false;
            };
            let Ok(item) = item_ty.create(None, Fragment::from(vec![list]), vec![]) else {
                return false;
            };
            let open = if nested_before { 3 } else { 1 };
            let slice = Slice::new(Fragment::from(vec![item]), open, 0);
            let (before, after) = (range.start(), range.end());
            let mut tr = state.tr();
            if tr
                .step(Box::new(ReplaceAroundStep::new(
                    before - open,
                    after,
                    before,
                    after,
                    slice,
                    1,
                    true,
                )))
                .is_err()
            {
                return false;
            }
            send(&mut dispatch, tr);
        }
        true
    })
}

/// [`split_list_item`], keeping the marks at the cursor (or the stored
/// marks) for the text typed in the new item.
pub fn split_list_item_keep_marks(item_ty: NodeType, item_attrs: Option<Attrs>) -> BoxCommand {
    let split = split_list_item(item_ty, item_attrs);
    command(move |state, dispatch| {
        let Some(dispatch) = dispatch else {
            return split(state, None);
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
        split(state, Some(&mut keep))
    })
}

#[cfg(test)]
mod tests {
    use super::{super::test_util::*, *};

    fn list(s: &crate::rich_editor::model::Schema, items: Vec<Node>) -> Node {
        n(s, "bulletList", items)
    }

    fn item(s: &crate::rich_editor::model::Schema, content: Vec<Node>) -> Node {
        n(s, "listItem", content)
    }

    #[test]
    fn wrap_in_list_wraps_each_block_in_an_item() {
        let s = schema();
        let doc = n(&s, "doc", vec![p(&s, "a"), p(&s, "b")]);
        let wrap = wrap_in_list(s.node_type("bulletList").unwrap(), None);
        let wrapped = apply(&state(doc, 1, 5), wrap.as_ref()).unwrap();
        let expected = n(
            &s,
            "doc",
            vec![list(
                &s,
                vec![item(&s, vec![p(&s, "a")]), item(&s, vec![p(&s, "b")])],
            )],
        );
        assert!(wrapped.doc().eq(&expected), "{:?}", wrapped.doc().to_json());
    }

    #[test]
    fn sink_and_lift_list_items() {
        let s = schema();
        let item_ty = s.node_type("listItem").unwrap();
        // <ul><li>a</li><li>b|</li></ul>; "b" starts at 8.
        let doc = n(
            &s,
            "doc",
            vec![list(
                &s,
                vec![item(&s, vec![p(&s, "a")]), item(&s, vec![p(&s, "b")])],
            )],
        );
        let sink = sink_list_item(item_ty.clone());
        // The first item cannot sink.
        assert!(apply(&state(doc.clone(), 3, 3), sink.as_ref()).is_none());
        let sunk = apply(&state(doc.clone(), 9, 9), sink.as_ref()).unwrap();
        let nested = n(
            &s,
            "doc",
            vec![list(
                &s,
                vec![item(
                    &s,
                    vec![p(&s, "a"), list(&s, vec![item(&s, vec![p(&s, "b")])])],
                )],
            )],
        );
        assert!(sunk.doc().eq(&nested), "{:?}", sunk.doc().to_json());

        // Lifting the nested item brings it back.
        let lifted = apply(&sunk, lift_list_item(item_ty.clone()).as_ref()).unwrap();
        assert!(lifted.doc().eq(&doc), "{:?}", lifted.doc().to_json());

        // Lifting an outer item takes it out of the list.
        let out = apply(&state(doc, 9, 9), lift_list_item(item_ty).as_ref()).unwrap();
        let expected = n(
            &s,
            "doc",
            vec![list(&s, vec![item(&s, vec![p(&s, "a")])]), p(&s, "b")],
        );
        assert!(out.doc().eq(&expected), "{:?}", out.doc().to_json());
    }

    #[test]
    fn split_list_item_makes_a_new_item() {
        let s = schema();
        let item_ty = s.node_type("listItem").unwrap();
        let doc = n(&s, "doc", vec![list(&s, vec![item(&s, vec![p(&s, "ab")])])]);
        let split = apply(
            &state(doc, 4, 4),
            split_list_item(item_ty.clone(), None).as_ref(),
        )
        .unwrap();
        let expected = n(
            &s,
            "doc",
            vec![list(
                &s,
                vec![item(&s, vec![p(&s, "a")]), item(&s, vec![p(&s, "b")])],
            )],
        );
        assert!(split.doc().eq(&expected), "{:?}", split.doc().to_json());
        // In an empty last item of an outer list, it leaves the lifting
        // to the next command.
        let empty = n(
            &s,
            "doc",
            vec![list(
                &s,
                vec![item(&s, vec![p(&s, "a")]), item(&s, vec![p(&s, "")])],
            )],
        );
        assert!(apply(&state(empty, 8, 8), split_list_item(item_ty, None).as_ref()).is_none());
    }
}
