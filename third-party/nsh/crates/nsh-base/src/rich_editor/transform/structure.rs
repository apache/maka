//! Structural edits: lifting, wrapping, changing block types, splitting
//! and joining, and the checks and points that go with them
//! (prosemirror-transform's `structure.ts`).

use super::{
    replace::{allows_marks, cut_by_index, frag1, resolve, rp_after, rp_before},
    replace_step::{ReplaceAroundStep, ReplaceStep},
    step::StepError,
    transform::Transform,
};
use crate::rich_editor::model::{Attrs, Fragment, Mark, Node, NodeRange, NodeType, Slice};

fn can_cut(node: &Node, start: usize, end: usize) -> bool {
    (start == 0 || node.can_replace(start, node.child_count(), &Fragment::empty(), 0, 0))
        && (end == node.child_count() || node.can_replace(0, end, &Fragment::empty(), 0, 0))
}

/// The depth the content of `range` can be lifted to, never across an
/// isolating node; `None` when it cannot be lifted.
pub fn lift_target(range: &NodeRange) -> Option<usize> {
    let parent = range.parent();
    let content = cut_by_index(parent.content(), range.start_index(), range.end_index());
    let mut depth = range.depth;
    let (mut before, mut after) = (0, 0);
    loop {
        let node = range.from.node(depth);
        let index = range.from.index(depth) + before;
        let end_index = range.to.index_after(depth).saturating_sub(after);
        if depth < range.depth
            && node.can_replace(index, end_index, &content, 0, content.child_count())
        {
            return Some(depth);
        }
        if depth == 0 || node.ty().spec().isolating || !can_cut(node, index, end_index) {
            return None;
        }
        if index > 0 {
            before = 1;
        }
        if end_index < node.child_count() {
            after = 1;
        }
        depth -= 1;
    }
}

pub(crate) fn lift(tr: &mut Transform, range: &NodeRange, target: usize) -> Result<(), StepError> {
    let (rf, rt, depth) = (&range.from, &range.to, range.depth);
    let gap_start = rp_before(rf, depth + 1);
    let gap_end = rp_after(rt, depth + 1);
    let (mut start, mut end) = (gap_start, gap_end);

    let mut before = Fragment::empty();
    let mut open_start = 0;
    let mut splitting = false;
    for d in (target + 1..=depth).rev() {
        if splitting || rf.index(d) > 0 {
            splitting = true;
            before = frag1(rf.node(d).copy(before));
            open_start += 1;
        } else {
            start -= 1;
        }
    }
    let mut after = Fragment::empty();
    let mut open_end = 0;
    let mut splitting = false;
    for d in (target + 1..=depth).rev() {
        if splitting || rp_after(rt, d + 1) < rt.end(d) {
            splitting = true;
            after = frag1(rt.node(d).copy(after));
            open_end += 1;
        } else {
            end += 1;
        }
    }
    let insert = before.size() - open_start;
    tr.step(Box::new(ReplaceAroundStep::new(
        start,
        end,
        gap_start,
        gap_end,
        Slice {
            content: before.append(&after),
            open_start,
            open_end,
        },
        insert,
        true,
    )))?;
    Ok(())
}

/// The wrappers that put the content of `range` in a node of `ty` (with
/// `attrs`), adding nodes around and inside it where its parent or its
/// content require; `None` when no wrapping is valid. With `inner_range`,
/// that range's content is what has to fit inside.
pub fn find_wrapping(
    range: &NodeRange,
    ty: &NodeType,
    attrs: Option<Attrs>,
    inner_range: Option<&NodeRange>,
) -> Option<Vec<(NodeType, Option<Attrs>)>> {
    let around = find_wrapping_outside(range, ty)?;
    let inner = find_wrapping_inside(inner_range.unwrap_or(range), ty)?;
    let mut result: Vec<(NodeType, Option<Attrs>)> =
        around.into_iter().map(|t| (t, None)).collect();
    result.push((ty.clone(), attrs));
    result.extend(inner.into_iter().map(|t| (t, None)));
    Some(result)
}

fn find_wrapping_outside(range: &NodeRange, ty: &NodeType) -> Option<Vec<NodeType>> {
    let parent = range.parent();
    let (start, end) = (range.start_index(), range.end_index());
    let around = parent.content_match_at(start)?.find_wrapping(ty)?;
    let outer = around.first().cloned().unwrap_or_else(|| ty.clone());
    parent
        .can_replace_with(start, end, &outer, None)
        .then_some(around)
}

fn find_wrapping_inside(range: &NodeRange, ty: &NodeType) -> Option<Vec<NodeType>> {
    let parent = range.parent();
    let (start, end) = (range.start_index(), range.end_index());
    let inner = parent.child(start).clone();
    let inside = ty.content_match().find_wrapping(inner.ty())?;
    let last = inside.last().cloned().unwrap_or_else(|| ty.clone());
    let mut m = Some(last.content_match());
    for i in start..end {
        m = m.and_then(|m| m.match_type(parent.child(i).ty()));
    }
    m.filter(|m| m.valid_end()).map(|_| inside)
}

pub(crate) fn wrap(
    tr: &mut Transform,
    range: &NodeRange,
    wrappers: &[(NodeType, Option<Attrs>)],
) -> Result<(), StepError> {
    let mut content = Fragment::empty();
    for (ty, attrs) in wrappers.iter().rev() {
        if content.size() > 0 {
            let fits = ty
                .content_match()
                .match_fragment(&content, 0, content.child_count())
                .is_some_and(|m| m.valid_end());
            if !fits {
                return Err(StepError::Invalid(
                    "wrapper type does not form valid content of its parent wrapper".into(),
                ));
            }
        }
        let node = ty
            .create(attrs.clone(), content, Vec::new())
            .map_err(|e| StepError::Invalid(e.to_string()))?;
        content = frag1(node);
    }
    let (start, end) = (range.start(), range.end());
    tr.step(Box::new(ReplaceAroundStep::new(
        start,
        end,
        start,
        end,
        Slice {
            content,
            open_start: 0,
            open_end: 0,
        },
        wrappers.len(),
        true,
    )))?;
    Ok(())
}

pub(crate) fn set_block_type(
    tr: &mut Transform,
    from: usize,
    to: usize,
    ty: &NodeType,
    attrs: &dyn Fn(&Node) -> Option<Attrs>,
) -> Result<(), StepError> {
    if !ty.is_textblock() {
        return Err(StepError::Invalid(
            "type given to set_block_type should be a textblock".into(),
        ));
    }
    let map_from = tr.steps.len();
    let doc = tr.doc.clone();
    let mut error = None;
    doc.nodes_between(
        from,
        to,
        &mut |node: &Node, pos: usize, _parent: Option<&Node>, _index: usize| {
            if error.is_some() {
                return false;
            }
            let attrs_here = attrs(node);
            if node.is_textblock()
                && !node.has_markup(ty, attrs_here.as_ref(), Some(node.marks()))
                && can_change_type(&tr.doc, tr.mapping.slice_from(map_from).map(pos, 1), ty)
            {
                let result = (|| {
                    let convert = convert_newlines(ty);
                    if convert == Some(false) {
                        replace_linebreaks(tr, node, pos, map_from)?;
                    }
                    // Clear the markup the new type does not allow first.
                    let at = tr.mapping.slice_from(map_from).map(pos, 1);
                    super::transform::clear_incompatible(tr, at, ty, None, convert.is_none())?;
                    let mapping = tr.mapping.slice_from(map_from);
                    let start = mapping.map(pos, 1);
                    let end = mapping.map(pos + node.node_size(), 1);
                    let new_node = ty
                        .create(attrs_here.clone(), Fragment::empty(), node.marks().to_vec())
                        .map_err(|e| StepError::Invalid(e.to_string()))?;
                    tr.step(Box::new(ReplaceAroundStep::new(
                        start,
                        end,
                        start + 1,
                        end - 1,
                        Slice {
                            content: frag1(new_node),
                            open_start: 0,
                            open_end: 0,
                        },
                        1,
                        true,
                    )))?;
                    if convert == Some(true) {
                        replace_newlines(tr, node, pos, map_from)?;
                    }
                    Ok::<(), StepError>(())
                })();
                if let Err(e) = result {
                    error = Some(e);
                }
                return false;
            }
            true
        },
    );
    error.map_or(Ok(()), Err)
}

/// Whether changing a textblock to `ty` turns line breaks into the
/// schema's line break node (`Some(true)`), that node into `\n`
/// (`Some(false)`), or neither: a `pre` type without the node keeps `\n`,
/// a normal type that allows the node takes it instead.
fn convert_newlines(ty: &NodeType) -> Option<bool> {
    let lb = ty.schema().linebreak_replacement()?;
    let pre = ty.whitespace() == "pre";
    let supports = ty.content_match().match_type(&lb).is_some();
    match (pre, supports) {
        (true, false) => Some(false),
        (false, true) => Some(true),
        _ => None,
    }
}

/// Replaces the newlines in the text of `node` (at `pos` before the steps
/// from `map_from`) with line break nodes.
fn replace_newlines(
    tr: &mut Transform,
    node: &Node,
    pos: usize,
    map_from: usize,
) -> Result<(), StepError> {
    let Some(lb) = node.ty().schema().linebreak_replacement() else {
        return Ok(());
    };
    let mut offset = 0;
    for i in 0..node.child_count() {
        let child = node.child(i).clone();
        if let Some(text) = child.text() {
            for (index, _) in super::transform::newlines(text) {
                let start = tr
                    .mapping
                    .slice_from(map_from)
                    .map(pos + 1 + offset + index, 1);
                let br = lb
                    .create(None, Fragment::empty(), Vec::new())
                    .map_err(|e| StepError::Invalid(e.to_string()))?;
                tr.replace_with(start, start + 1, frag1(br))?;
            }
        }
        offset += child.node_size();
    }
    Ok(())
}

/// Replaces the line break nodes in `node` with `\n` text.
fn replace_linebreaks(
    tr: &mut Transform,
    node: &Node,
    pos: usize,
    map_from: usize,
) -> Result<(), StepError> {
    let Some(lb) = node.ty().schema().linebreak_replacement() else {
        return Ok(());
    };
    let mut offset = 0;
    for i in 0..node.child_count() {
        let child = node.child(i).clone();
        if *child.ty() == lb {
            let start = tr.mapping.slice_from(map_from).map(pos + 1 + offset, 1);
            let text = node.ty().schema().text("\n", Vec::new());
            tr.replace_with(start, start + 1, frag1(text))?;
        }
        offset += child.node_size();
    }
    Ok(())
}

fn can_change_type(doc: &Node, pos: usize, ty: &NodeType) -> bool {
    let Ok(rp) = doc.resolve(pos) else {
        return false;
    };
    let index = rp.index(rp.depth);
    rp.parent().can_replace_with(index, index + 1, ty, None)
}

pub(crate) fn set_node_markup(
    tr: &mut Transform,
    pos: usize,
    ty: Option<NodeType>,
    attrs: Option<Attrs>,
    marks: Option<Vec<Mark>>,
) -> Result<(), StepError> {
    let node = tr
        .doc
        .node_at(pos)
        .ok_or_else(|| StepError::Invalid(format!("no node at position {pos}")))?;
    let ty = ty.unwrap_or_else(|| node.ty().clone());
    let new_node = ty
        .create(
            attrs,
            Fragment::empty(),
            marks.unwrap_or_else(|| node.marks().to_vec()),
        )
        .map_err(|e| StepError::Invalid(e.to_string()))?;
    if node.is_leaf() {
        tr.replace_with(pos, pos + node.node_size(), frag1(new_node))?;
        return Ok(());
    }
    if !ty.valid_content(node.content()) {
        return Err(StepError::Invalid(format!(
            "invalid content for node type {}",
            ty.name()
        )));
    }
    tr.step(Box::new(ReplaceAroundStep::new(
        pos,
        pos + node.node_size(),
        pos + 1,
        pos + node.node_size() - 1,
        Slice {
            content: frag1(new_node),
            open_start: 0,
            open_end: 0,
        },
        1,
        true,
    )))?;
    Ok(())
}

/// The type to give one split-off node: `None` keeps the original's.
pub type TypeAfter = Option<(NodeType, Option<Attrs>)>;

fn type_at(types: &[TypeAfter], i: isize) -> Option<&(NodeType, Option<Attrs>)> {
    if i < 0 {
        None
    } else {
        types.get(i as usize).and_then(Option::as_ref)
    }
}

/// Whether splitting at `pos`, `depth` levels deep, is allowed, the
/// split-off nodes (outermost first) given `types_after`'s types.
pub fn can_split(doc: &Node, pos: usize, depth: usize, types_after: Option<&[TypeAfter]>) -> bool {
    let types = types_after.unwrap_or(&[]);
    let Ok(rp) = doc.resolve(pos) else {
        return false;
    };
    if depth > rp.depth {
        return false;
    }
    let base = rp.depth - depth;
    let parent = rp.parent();
    let inner_ty = types
        .last()
        .and_then(Option::as_ref)
        .map(|t| t.0.clone())
        .unwrap_or_else(|| parent.ty().clone());
    let index = rp.index(rp.depth);
    if parent.ty().spec().isolating
        || !parent.can_replace(index, parent.child_count(), &Fragment::empty(), 0, 0)
        || !inner_ty.valid_content(&cut_by_index(parent.content(), index, parent.child_count()))
    {
        return false;
    }
    let mut i = depth as isize - 2;
    let mut d = rp.depth as isize - 1;
    while d > base as isize {
        let du = d as usize;
        let node = rp.node(du);
        let index = rp.index(du);
        if node.ty().spec().isolating {
            return false;
        }
        let mut rest = cut_by_index(node.content(), index, node.child_count());
        if let Some((ty, attrs)) = type_at(types, i + 1) {
            let Ok(child) = ty.create(attrs.clone(), Fragment::empty(), Vec::new()) else {
                return false;
            };
            rest = rest.replace_child(0, child);
        }
        let after = type_at(types, i)
            .map(|t| t.0.clone())
            .unwrap_or_else(|| node.ty().clone());
        if !node.can_replace(index + 1, node.child_count(), &Fragment::empty(), 0, 0)
            || !after.valid_content(&rest)
        {
            return false;
        }
        d -= 1;
        i -= 1;
    }
    let index = rp.index_after(base);
    let base_ty = type_at(types, 0)
        .map(|t| t.0.clone())
        .unwrap_or_else(|| rp.node(base + 1).ty().clone());
    rp.node(base).can_replace_with(index, index, &base_ty, None)
}

pub(crate) fn split(
    tr: &mut Transform,
    pos: usize,
    depth: usize,
    types: &[TypeAfter],
) -> Result<(), StepError> {
    let rp = resolve(&tr.doc, pos)?;
    if depth > rp.depth {
        return Err(StepError::Invalid("split deeper than the position".into()));
    }
    let mut before = Fragment::empty();
    let mut after = Fragment::empty();
    let e = rp.depth - depth;
    let mut i = depth as isize - 1;
    for d in (e + 1..=rp.depth).rev() {
        before = frag1(rp.node(d).copy(before));
        after = frag1(match type_at(types, i) {
            Some((ty, attrs)) => ty
                .create(attrs.clone(), after, Vec::new())
                .map_err(|e| StepError::Invalid(e.to_string()))?,
            None => rp.node(d).copy(after),
        });
        i -= 1;
    }
    tr.step(Box::new(ReplaceStep::new(
        pos,
        pos,
        Slice {
            content: before.append(&after),
            open_start: depth,
            open_end: depth,
        },
        true,
    )))?;
    Ok(())
}

/// Whether the blocks before and after `pos` can be joined.
pub fn can_join(doc: &Node, pos: usize) -> bool {
    let Ok(rp) = doc.resolve(pos) else {
        return false;
    };
    let index = rp.index(rp.depth);
    joinable(rp.node_before().as_ref(), rp.node_after().as_ref())
        && rp
            .parent()
            .can_replace(index, index + 1, &Fragment::empty(), 0, 0)
}

fn can_append(a: &Node, b: &Node) -> bool {
    let Some(mut m) = a.content_match_at(a.child_count()) else {
        return false;
    };
    let lb = a.ty().schema().linebreak_replacement();
    for i in 0..b.child_count() {
        let child = b.child(i);
        // A line break node joins a textblock as the text it stands for.
        let ty = if lb.as_ref() == Some(child.ty()) {
            a.ty().schema().text_type()
        } else {
            child.ty().clone()
        };
        match m.match_type(&ty) {
            Some(next) => m = next,
            None => return false,
        }
        if !allows_marks(a.ty(), child.marks()) {
            return false;
        }
    }
    m.valid_end()
}

fn joinable(a: Option<&Node>, b: Option<&Node>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => !a.is_leaf() && can_append(a, b),
        _ => false,
    }
}

/// The nearest point at or above `pos` where an ancestor can be joined to
/// the block before it (after it with a positive `dir`).
pub fn join_point(doc: &Node, pos: usize, dir: i32) -> Option<usize> {
    let rp = doc.resolve(pos).ok()?;
    let mut pos = pos;
    let mut d = rp.depth;
    loop {
        let mut index = rp.index(d);
        let (before, after) = if d == rp.depth {
            (rp.node_before(), rp.node_after())
        } else if dir > 0 {
            index += 1;
            (
                Some(rp.node(d + 1).clone()),
                rp.node(d).maybe_child(index).cloned(),
            )
        } else {
            let before = if index > 0 {
                rp.node(d).maybe_child(index - 1).cloned()
            } else {
                None
            };
            (before, Some(rp.node(d + 1).clone()))
        };
        if before.as_ref().is_some_and(|b| !b.is_textblock())
            && joinable(before.as_ref(), after.as_ref())
            && rp
                .node(d)
                .can_replace(index, index + 1, &Fragment::empty(), 0, 0)
        {
            return Some(pos);
        }
        if d == 0 {
            return None;
        }
        pos = if dir < 0 { rp.before(d) } else { rp.after(d) };
        d -= 1;
    }
}

pub(crate) fn join(tr: &mut Transform, pos: usize, depth: usize) -> Result<(), StepError> {
    let before = resolve(
        &tr.doc,
        pos.checked_sub(depth)
            .ok_or_else(|| StepError::Invalid("join out of range".into()))?,
    )?;
    let before_ty = before.parent().ty().clone();
    let convert = if before_ty.inline_content() {
        convert_newlines(&before_ty)
    } else {
        None
    };
    let map_from = tr.steps.len();
    if convert == Some(false) {
        let after = resolve(&tr.doc, pos + depth)?;
        let node = after.parent().clone();
        replace_linebreaks(tr, &node, after.before(after.depth), map_from)?;
    }
    if before_ty.inline_content() {
        let m = before.parent().content_match_at(before.index(before.depth));
        super::transform::clear_incompatible(
            tr,
            pos + depth - 1,
            &before_ty,
            m,
            convert.is_none(),
        )?;
    }
    let mapping = tr.mapping.slice_from(map_from);
    let start = mapping.map(pos - depth, 1);
    let end = mapping.map(pos + depth, -1);
    tr.step(Box::new(ReplaceStep::new(start, end, Slice::empty(), true)))?;
    if convert == Some(true) {
        let full = resolve(&tr.doc, start)?;
        let node = full.parent().clone();
        let steps = tr.steps.len();
        replace_newlines(tr, &node, full.before(full.depth), steps)?;
    }
    Ok(())
}

/// A point at or around `pos` where a node of `ty` can be inserted,
/// moving up from the start or end of a node that does not allow it.
pub fn insert_point(doc: &Node, pos: usize, ty: &NodeType) -> Option<usize> {
    let rp = doc.resolve(pos).ok()?;
    let index = rp.index(rp.depth);
    if rp.parent().can_replace_with(index, index, ty, None) {
        return Some(pos);
    }
    if rp.parent_offset == 0 {
        for d in (0..rp.depth).rev() {
            let index = rp.index(d);
            if rp.node(d).can_replace_with(index, index, ty, None) {
                return Some(rp.before(d + 1));
            }
            if index > 0 {
                return None;
            }
        }
    }
    if rp.parent_offset == rp.parent().content().size() {
        for d in (0..rp.depth).rev() {
            let index = rp.index_after(d);
            if rp.node(d).can_replace_with(index, index, ty, None) {
                return Some(rp.after(d + 1));
            }
            if index < rp.node(d).child_count() {
                return None;
            }
        }
    }
    None
}

/// A point at or around `pos` where `slice` can be dropped, trying the
/// nearest boundaries of its ancestors.
pub fn drop_point(doc: &Node, pos: usize, slice: &Slice) -> Option<usize> {
    let rp = doc.resolve(pos).ok()?;
    if slice.content.size() == 0 {
        return Some(pos);
    }
    let mut content = slice.content.clone();
    for _ in 0..slice.open_start {
        content = content.child(0).content().clone();
    }
    let passes = if slice.open_start == 0 && slice.size() > 0 {
        2
    } else {
        1
    };
    for pass in 1..=passes {
        for d in (0..=rp.depth).rev() {
            let bias = if d == rp.depth {
                0
            } else if rp.pos * 2 <= rp.start(d + 1) + rp.end(d + 1) {
                -1
            } else {
                1
            };
            let insert_pos = rp.index(d) + usize::from(bias > 0);
            let parent = rp.node(d);
            let fits = if pass == 1 {
                parent.can_replace(insert_pos, insert_pos, &content, 0, content.child_count())
            } else {
                content.child_count() > 0
                    && parent
                        .content_match_at(insert_pos)
                        .and_then(|m| m.find_wrapping(content.child(0).ty()))
                        .and_then(|w| w.first().cloned())
                        .is_some_and(|w| parent.can_replace_with(insert_pos, insert_pos, &w, None))
            };
            if fits {
                return Some(match bias {
                    0 => rp.pos,
                    b if b < 0 => rp.before(d + 1),
                    _ => rp.after(d + 1),
                });
            }
        }
    }
    None
}
