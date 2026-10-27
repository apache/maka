//! Tiptap's `ListKeymap`: Backspace, Delete and Tab around list items join
//! paragraphs into items instead of lifting and sinking them as
//! ProseMirror's defaults would. Ported from `@tiptap/extension-list`'s
//! `keymap/`.

use super::{
    helpers::{
        Step, chain, find_parent_node, is_at_end_of_node, is_at_start_of_node, join_item_forward,
    },
    input_rules::undo_input_rule,
};
use crate::rich_editor::{
    commands::{
        BoxCommand, Dispatch, command, is_node_active, join_backward, join_textblock_backward,
        join_textblock_forward, lift, lift_list_item,
    },
    model::{Fragment, NodeType, ResolvedPos},
    state::{EditorState, Selection, TextSelection},
};

/// A list item type and the list types that hold it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ListType {
    /// The item type's name (`listItem`).
    pub item_name: String,
    /// The names of the list types holding it (`bulletList`, `orderedList`).
    pub wrapper_names: Vec<String>,
}

impl ListType {
    /// Items of `item_name` in lists of `wrapper_names`.
    pub fn new(item_name: &str, wrapper_names: &[&str]) -> Self {
        Self {
            item_name: item_name.into(),
            wrapper_names: wrapper_names.iter().map(|&n| n.into()).collect(),
        }
    }
}

/// The options of [`list_keymap`].
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ListKeymapOptions {
    /// The item types and their lists: Tiptap's `listItem` in `bulletList`
    /// and `orderedList`, and `taskItem` in `taskList`, by default.
    pub list_types: Vec<ListType>,
}

impl Default for ListKeymapOptions {
    fn default() -> Self {
        Self {
            list_types: vec![
                ListType::new("listItem", &["bulletList", "orderedList"]),
                ListType::new("taskItem", &["taskList"]),
            ],
        }
    }
}

/// The bindings of Tiptap's `ListKeymap` for the item types `options` names
/// that the schema has: `Backspace` / `Mod-Backspace`, `Delete` /
/// `Mod-Delete` and `Tab`.
pub fn list_keymap(options: &ListKeymapOptions) -> Vec<(String, BoxCommand)> {
    let types = options.list_types.clone();
    let backspace = {
        let types = types.clone();
        command(move |state, mut dispatch| {
            types.iter().any(|list| {
                let Some(item) = state.schema().node_type(&list.item_name) else {
                    return false;
                };
                handle_backspace(state, reborrow(&mut dispatch), &item, &list.wrapper_names)
            })
        })
    };
    let delete = {
        let types = types.clone();
        command(move |state, mut dispatch| {
            types.iter().any(|list| {
                let Some(item) = state.schema().node_type(&list.item_name) else {
                    return false;
                };
                handle_delete(state, reborrow(&mut dispatch), &item)
            })
        })
    };
    let tab = command(move |state, mut dispatch| {
        types.iter().any(|list| {
            let Some(item) = state.schema().node_type(&list.item_name) else {
                return false;
            };
            handle_tab(state, reborrow(&mut dispatch), &item, &list.wrapper_names)
        })
    });
    vec![
        ("Delete".into(), delete.clone()),
        ("Mod-Delete".into(), delete),
        ("Backspace".into(), backspace.clone()),
        ("Mod-Backspace".into(), backspace),
        ("Tab".into(), tab),
    ]
}

fn reborrow<'a>(dispatch: &'a mut Dispatch<'_>) -> Dispatch<'a> {
    match dispatch {
        Some(dispatch) => Some(&mut **dispatch),
        None => None,
    }
}

// Whether the node right before the cursor's textblock is a list of
// `wrappers` (Tiptap's `hasListBefore`).
fn has_list_before(state: &EditorState, wrappers: &[String]) -> bool {
    let anchor = state.selection().anchor();
    let Ok(at) = state.doc().resolve(anchor.saturating_sub(2)) else {
        return false;
    };
    wrappers.iter().any(|w| w == at.parent().ty().name())
}

/// Tiptap's list Backspace: takes back an input rule; at the start of a
/// paragraph right after a list, moves the paragraph into the list's last
/// item and joins it with that item's text; at the start of an item's
/// first child, lifts the item out.
pub fn handle_backspace(
    state: &EditorState,
    mut dispatch: Dispatch<'_>,
    item: &NodeType,
    wrappers: &[String],
) -> bool {
    if undo_input_rule(state, reborrow(&mut dispatch)) {
        return true;
    }
    let selection = state.selection();
    if selection.from() != selection.to() {
        return false;
    }
    if !is_node_active(state, item, None) && has_list_before(state, wrappers) {
        let anchor = selection.resolved_anchor().clone();
        if anchor.depth == 0 {
            return false;
        }
        let Ok(list_pos) = state.doc().resolve(anchor.before(anchor.depth) - 1) else {
            return false;
        };
        let mut last = None;
        list_pos.parent().descendants(&mut |node, pos, _, _| {
            if node.ty() == item {
                last = Some(pos);
            }
            true
        });
        let Some(last) = last else {
            return false;
        };
        let Ok(last_item) = state
            .doc()
            .resolve(list_pos.start(list_pos.depth) + last + 1)
        else {
            return false;
        };
        let target = last_item.end(last_item.depth);
        let block = anchor.parent().clone();
        let (before, after) = (anchor.before(anchor.depth), anchor.after(anchor.depth));
        let move_in = move |state: &EditorState, dispatch: Dispatch<'_>| {
            let mut tr = state.tr();
            if tr.delete(before, after).is_err()
                || tr.insert(target, Fragment::from(block.clone())).is_err()
            {
                return false;
            }
            tr.set_selection(TextSelection::create(tr.doc(), target + 1, None));
            if let Some(dispatch) = dispatch {
                dispatch(tr);
            }
            true
        };
        let join = |state: &EditorState, dispatch: Dispatch<'_>| {
            join_textblock_backward(state, dispatch);
            true
        };
        return chain(state, dispatch, &[&move_in, &join]);
    }
    if !is_node_active(state, item, None) || !is_at_start_of_node(state) {
        return false;
    }
    let from = selection.resolved_from();
    if from.depth < 1 {
        return false;
    }
    let item_depth = from.depth - 1;
    if from.node(item_depth).ty() != item || from.index(item_depth) != 0 {
        return false;
    }
    lift_list_item(item.clone())(state, dispatch)
}

// The cursor's innermost item of `item` and the position `depth` levels
// out of the cursor (Tiptap's `findListItemPos`).
fn find_list_item_pos(state: &EditorState, item: &NodeType) -> Option<(usize, usize)> {
    let from = state.selection().resolved_from();
    let found = find_parent_node(from, |n| n.ty() == item)?;
    if found.depth == 0 {
        return None;
    }
    Some((from.pos - (from.depth - found.depth), found.depth))
}

// The depth of the innermost item of `item` around the position four after
// the cursor's item position (Tiptap's `getNextListDepth`), 0 for none.
fn next_list_depth(state: &EditorState, item: &NodeType) -> Option<usize> {
    let (pos, _) = find_list_item_pos(state, item)?;
    let at: ResolvedPos = state.doc().resolve(pos + 4).ok()?;
    let depth = (1..=at.depth.min(20))
        .rev()
        .find(|&d| at.node(d).ty() == item)
        .unwrap_or(0);
    (depth > 0).then_some(depth)
}

/// Tiptap's list Delete: at the end of an item, joins the item after it
/// (a nested list's first item is lifted and joined, a shallower one's
/// text joined).
pub fn handle_delete(state: &EditorState, dispatch: Dispatch<'_>, item: &NodeType) -> bool {
    if !is_node_active(state, item, None)
        || !is_at_end_of_node(state, item)
        || !state.selection().empty()
    {
        return false;
    }
    let (Some(next), Some((_, depth))) = (
        next_list_depth(state, item),
        find_list_item_pos(state, item),
    ) else {
        return join_item_forward(state, dispatch);
    };
    if next > depth {
        let to = state.selection().from() + 4;
        let item = item.clone();
        let focus = move |state: &EditorState, dispatch: Dispatch<'_>| {
            let Ok(at) = state.doc().resolve(to) else {
                return false;
            };
            if let Some(dispatch) = dispatch {
                let mut tr = state.tr();
                tr.set_selection(Selection::near(&at, 1));
                dispatch(tr);
            }
            true
        };
        let lift_item = move |state: &EditorState, dispatch: Dispatch<'_>| {
            is_node_active(state, &item, None) && lift(state, dispatch)
        };
        let steps: [Step<'_>; 3] = [&focus, &lift_item, &join_backward];
        return chain(state, dispatch, &steps);
    }
    if next < depth {
        return join_textblock_forward(state, dispatch);
    }
    join_item_forward(state, dispatch)
}

/// Tiptap's list Tab: at the start of a textblock right after a list (and
/// not in an item), moves the block into the list's last item.
pub fn handle_tab(
    state: &EditorState,
    dispatch: Dispatch<'_>,
    item: &NodeType,
    wrappers: &[String],
) -> bool {
    let selection = state.selection();
    if !selection.empty() {
        return false;
    }
    let from = selection.resolved_from();
    if from.parent_offset != 0 || !from.parent().is_textblock() || from.depth == 0 {
        return false;
    }
    if is_node_active(state, item, None) {
        return false;
    }
    let index = from.index(from.depth - 1);
    if index == 0 {
        return false;
    }
    let previous = from.node(from.depth - 1).child(index - 1);
    if !wrappers.iter().any(|w| w == previous.ty().name()) {
        return false;
    }
    let Some(last) = previous.last_child() else {
        return false;
    };
    if last.ty() != item {
        return false;
    }
    let block = from.parent().clone();
    if !last.can_replace(
        last.child_count(),
        last.child_count(),
        &Fragment::from(block.clone()),
        0,
        1,
    ) {
        return false;
    }
    let (start, end) = (from.before(from.depth), from.after(from.depth));
    let inside = start - 2;
    if let Some(dispatch) = dispatch {
        let mut tr = state.tr();
        if tr.delete(start, end).is_err() || tr.insert(inside, Fragment::from(block)).is_err() {
            return false;
        }
        tr.set_selection(TextSelection::create(tr.doc(), inside + 1, None));
        tr.scroll_into_view();
        dispatch(tr);
    }
    true
}
