//! Fitting a slice into a range of a document: the Fitter behind
//! [`replace_step`], and the WYSIWYG-friendly range replacements of
//! [`Transform`] (prosemirror-transform's `replace.ts`).

use super::{
    replace_step::{ReplaceAroundStep, ReplaceStep},
    step::{BoxStep, StepError},
    structure::insert_point,
    transform::Transform,
};
use crate::rich_editor::model::{
    Attrs, ContentMatch, Fragment, Mark, Node, NodeType, ResolvedPos, Slice,
};

// Small helpers the other transform files share.

/// A fragment of one node.
pub(crate) fn frag1(node: Node) -> Fragment {
    Fragment::from(vec![node])
}

/// The children `from..to` of a fragment (ProseMirror's `cutByIndex`).
pub(crate) fn cut_by_index(fragment: &Fragment, from: usize, to: usize) -> Fragment {
    Fragment::from(
        (from..to)
            .map(|i| fragment.child(i).clone())
            .collect::<Vec<Node>>(),
    )
}

/// The marks of `marks` that `ty` allows in its content.
pub(crate) fn allowed_marks(ty: &NodeType, marks: &[Mark]) -> Vec<Mark> {
    marks
        .iter()
        .filter(|m| ty.allows_mark_type(&m.ty))
        .cloned()
        .collect()
}

/// Whether `ty` allows all of `marks` in its content.
pub(crate) fn allows_marks(ty: &NodeType, marks: &[Mark]) -> bool {
    marks.iter().all(|m| ty.allows_mark_type(&m.ty))
}

/// Resolves a position, failing as an invalid transform.
pub(crate) fn resolve(doc: &Node, pos: usize) -> Result<ResolvedPos, StepError> {
    doc.resolve(pos)
        .map_err(|e| StepError::Invalid(e.to_string()))
}

/// `rp.before(d)`, where depth `rp.depth + 1` is the position itself.
pub(crate) fn rp_before(rp: &ResolvedPos, depth: usize) -> usize {
    if depth == rp.depth + 1 {
        rp.pos
    } else {
        rp.before(depth)
    }
}

/// `rp.after(d)`, where depth `rp.depth + 1` is the position itself.
pub(crate) fn rp_after(rp: &ResolvedPos, depth: usize) -> usize {
    if depth == rp.depth + 1 {
        rp.pos
    } else {
        rp.after(depth)
    }
}

fn match_all(m: &ContentMatch, fragment: &Fragment) -> Option<ContentMatch> {
    m.match_fragment(fragment, 0, fragment.child_count())
}

/// Fits `slice` into `from..to` of `doc`: the step that inserts it,
/// closing and wrapping nodes as needed, or `None` when it has no
/// meaningful place there or replacing would change nothing.
pub fn replace_step(doc: &Node, from: usize, to: usize, slice: &Slice) -> Option<BoxStep> {
    if from == to && slice.size() == 0 {
        return None;
    }
    let rf = doc.resolve(from).ok()?;
    let rt = doc.resolve(to).ok()?;
    if fits_trivially(&rf, &rt, slice) {
        return Some(Box::new(ReplaceStep::new(from, to, slice.clone(), false)));
    }
    Fitter::new(rf, rt, slice.clone())?.fit()
}

fn fits_trivially(rf: &ResolvedPos, rt: &ResolvedPos, slice: &Slice) -> bool {
    slice.open_start == 0
        && slice.open_end == 0
        && rf.start(rf.depth) == rt.start(rt.depth)
        && rf.parent().can_replace(
            rf.index(rf.depth),
            rt.index(rt.depth),
            &slice.content,
            0,
            slice.content.child_count(),
        )
}

struct Fittable {
    slice_depth: usize,
    frontier_depth: usize,
    parent: Option<Node>,
    inject: Option<Fragment>,
    wrap: Option<Vec<NodeType>>,
}

#[derive(Clone)]
struct Frontier {
    ty: NodeType,
    m: ContentMatch,
}

struct CloseLevel {
    depth: usize,
    fit: Fragment,
    mv: ResolvedPos,
}

// Places the content of a slice into a gap. The content of each node
// open on the slice's left is placeable on its own. `frontier` is the
// open side of the replacement: it starts at `from`, moves on as content
// is placed and is finally reconciled with `to`. `unplaced` is what is
// left to place, `placed` what was placed (its open start implied by
// `from`, its open end by `frontier`).
struct Fitter {
    from: ResolvedPos,
    to: ResolvedPos,
    unplaced: Slice,
    frontier: Vec<Frontier>,
    placed: Fragment,
}

impl Fitter {
    fn new(from: ResolvedPos, to: ResolvedPos, unplaced: Slice) -> Option<Self> {
        let mut frontier = Vec::with_capacity(from.depth + 1);
        for i in 0..=from.depth {
            let node = from.node(i);
            frontier.push(Frontier {
                ty: node.ty().clone(),
                m: node.content_match_at(from.index_after(i))?,
            });
        }
        let mut placed = Fragment::empty();
        for i in (1..=from.depth).rev() {
            placed = frag1(from.node(i).copy(placed));
        }
        Some(Self {
            from,
            to,
            unplaced,
            frontier,
            placed,
        })
    }

    fn depth(&self) -> usize {
        self.frontier.len() - 1
    }

    fn fit(mut self) -> Option<BoxStep> {
        // Place what fits; otherwise open the slice further or drop a
        // node of it, and try again.
        while self.unplaced.size() > 0 {
            if let Some(fit) = self.find_fittable() {
                self.place_nodes(fit)?;
            } else if !self.open_more() {
                self.drop_node();
            }
        }
        // Inline content right after the frontier and right after `to`
        // is pulled into the frontier's node with a replace-around step,
        // so the fit runs to the end of the textblock after `to`.
        let move_inline = self.must_move_inline();
        let placed_size =
            self.placed.size() as isize - self.depth() as isize - self.from.depth as isize;
        let from = self.from.clone();
        let close_to = match move_inline {
            None => self.to.clone(),
            Some(p) => from.doc().resolve(p).ok()?,
        };
        let to = self.close(close_to)?;

        let mut content = self.placed.clone();
        let (mut open_start, mut open_end) = (from.depth, to.depth);
        // Drop open parent nodes the two sides share.
        while open_start > 0 && open_end > 0 && content.child_count() == 1 {
            content = content.child(0).content().clone();
            open_start -= 1;
            open_end -= 1;
        }
        let slice = Slice {
            content,
            open_start,
            open_end,
        };
        if let Some(mi) = move_inline {
            return Some(Box::new(ReplaceAroundStep::new(
                from.pos,
                mi,
                self.to.pos,
                self.to.end(self.to.depth),
                slice,
                placed_size.max(0) as usize,
                false,
            )));
        }
        if slice.size() > 0 || from.pos != self.to.pos {
            return Some(Box::new(ReplaceStep::new(from.pos, to.pos, slice, false)));
        }
        None
    }

    // A depth on the start spine of `unplaced` whose content can move to
    // a depth of the frontier.
    fn find_fittable(&self) -> Option<Fittable> {
        let mut start_depth = self.unplaced.open_start;
        let mut cur = self.unplaced.content.clone();
        let mut open_end = self.unplaced.open_end;
        for d in 0..start_depth {
            let node = cur.child(0).clone();
            if cur.child_count() > 1 {
                open_end = 0;
            }
            if node.ty().spec().isolating && open_end <= d {
                start_depth = d;
                break;
            }
            cur = node.content().clone();
        }

        // Wrapping (pass 2) only when no place without wrapping exists.
        for pass in 1..=2 {
            let top = if pass == 1 {
                start_depth
            } else {
                self.unplaced.open_start
            };
            for slice_depth in (0..=top).rev() {
                let (fragment, parent) = if slice_depth > 0 {
                    let parent = content_at(&self.unplaced.content, slice_depth - 1)
                        .child(0)
                        .clone();
                    (parent.content().clone(), Some(parent))
                } else {
                    (self.unplaced.content.clone(), None)
                };
                let first = (fragment.child_count() > 0).then(|| fragment.child(0).clone());
                for frontier_depth in (0..=self.depth()).rev() {
                    let Frontier { ty, m } = &self.frontier[frontier_depth];
                    if pass == 1 {
                        let found = match &first {
                            Some(first) => {
                                if m.match_type(first.ty()).is_some() {
                                    Some(None)
                                } else {
                                    m.fill_before(&frag1(first.clone()), false, 0).map(Some)
                                }
                            }
                            None => parent
                                .as_ref()
                                .filter(|p| ty.compatible_content(p.ty()))
                                .map(|_| None),
                        };
                        if let Some(inject) = found {
                            return Some(Fittable {
                                slice_depth,
                                frontier_depth,
                                parent,
                                inject,
                                wrap: None,
                            });
                        }
                    } else if let Some(first) = &first
                        && let Some(wrap) = m.find_wrapping(first.ty())
                    {
                        return Some(Fittable {
                            slice_depth,
                            frontier_depth,
                            parent,
                            inject: None,
                            wrap: Some(wrap),
                        });
                    }
                    // Stop going up when the parent itself fits here.
                    if let Some(p) = &parent
                        && m.match_type(p.ty()).is_some()
                    {
                        break;
                    }
                }
            }
        }
        None
    }

    fn open_more(&mut self) -> bool {
        let Slice {
            content,
            open_start,
            mut open_end,
            ..
        } = self.unplaced.clone();
        if max_open(&content, false) <= open_start {
            return false;
        }
        if self.unplaced.size() > 1 && max_open(&content, true) > open_end {
            open_end += 1;
        }
        self.unplaced = Slice {
            content,
            open_start: open_start + 1,
            open_end,
        };
        true
    }

    fn drop_node(&mut self) {
        let Slice {
            content,
            open_start,
            open_end,
            ..
        } = self.unplaced.clone();
        let inner = content_at(&content, open_start);
        if inner.child_count() <= 1 && open_start > 0 {
            let open_at_end = content.size() as isize - open_start as isize
                <= open_start as isize + inner.size() as isize;
            self.unplaced = Slice {
                content: drop_from_fragment(&content, open_start - 1, 1),
                open_start: open_start - 1,
                open_end: if open_at_end {
                    open_start - 1
                } else {
                    open_end
                },
            };
        } else {
            self.unplaced = Slice {
                content: drop_from_fragment(&content, open_start, 1),
                open_start,
                open_end,
            };
        }
    }

    // Moves content of `unplaced` at `slice_depth` to the frontier node at
    // `frontier_depth`, closing that node when it is complete.
    fn place_nodes(&mut self, fit: Fittable) -> Option<()> {
        let Fittable {
            slice_depth,
            frontier_depth,
            parent,
            inject,
            wrap,
        } = fit;
        while self.depth() > frontier_depth {
            self.close_frontier_node();
        }
        if let Some(wrap) = wrap {
            for ty in wrap {
                self.open_frontier_node(ty, None, None)?;
            }
        }

        let slice = self.unplaced.clone();
        let fragment = match &parent {
            Some(p) => p.content().clone(),
            None => slice.content.clone(),
        };
        let open_start = slice.open_start - slice_depth;
        let mut taken = 0;
        let mut add: Vec<Node> = Vec::new();
        let Frontier { ty, mut m } = self.frontier[frontier_depth].clone();
        if let Some(inject) = &inject {
            for i in 0..inject.child_count() {
                add.push(inject.child(i).clone());
            }
            m = match_all(&m, inject)?;
        }
        // The open nodes at the end of the fragment: 0 when only the
        // parent is open, negative when nothing is.
        let mut open_end_count = (fragment.size() + slice_depth) as isize
            - (slice.content.size() as isize - slice.open_end as isize);
        while taken < fragment.child_count() {
            let next = fragment.child(taken).clone();
            let Some(matches) = m.match_type(next.ty()) else {
                break;
            };
            taken += 1;
            // Empty open nodes are dropped.
            if taken > 1 || open_start == 0 || next.content().size() > 0 {
                m = matches;
                add.push(close_node_start(
                    next.mark(allowed_marks(&ty, next.marks())),
                    if taken == 1 { open_start as isize } else { 0 },
                    if taken == fragment.child_count() {
                        open_end_count
                    } else {
                        -1
                    },
                ));
            }
        }
        let to_end = taken == fragment.child_count();
        if !to_end {
            open_end_count = -1;
        }

        self.placed = add_to_fragment(&self.placed, frontier_depth, &Fragment::from(add));
        self.frontier[frontier_depth].m = m;

        // The whole node was moved, is not open and its type matches:
        // close the frontier node right away.
        if to_end
            && open_end_count < 0
            && parent
                .as_ref()
                .is_some_and(|p| *p.ty() == self.frontier[self.depth()].ty)
            && self.frontier.len() > 1
        {
            self.close_frontier_node();
        }

        // Open frontier nodes for the open nodes at the end.
        let mut cur = fragment.clone();
        for _ in 0..open_end_count.max(0) {
            let node = cur.child(cur.child_count() - 1).clone();
            let m = node.content_match_at(node.child_count())?;
            self.frontier.push(Frontier {
                ty: node.ty().clone(),
                m,
            });
            cur = node.content().clone();
        }

        // Drop the placed nodes, or the whole node when placing reached
        // its end.
        self.unplaced = if !to_end {
            Slice {
                content: drop_from_fragment(&slice.content, slice_depth, taken),
                open_start: slice.open_start,
                open_end: slice.open_end,
            }
        } else if slice_depth == 0 {
            Slice::empty()
        } else {
            Slice {
                content: drop_from_fragment(&slice.content, slice_depth - 1, 1),
                open_start: slice_depth - 1,
                open_end: if open_end_count < 0 {
                    slice.open_end
                } else {
                    slice_depth - 1
                },
            }
        };
        Some(())
    }

    fn must_move_inline(&self) -> Option<usize> {
        if !self.to.parent().is_textblock() {
            return None;
        }
        let top = &self.frontier[self.depth()];
        if !top.ty.is_textblock()
            || content_after_fits(&self.to, self.to.depth, &top.ty, &top.m, false).is_none()
            || (self.to.depth == self.depth()
                && self
                    .find_close_level(&self.to)
                    .is_some_and(|l| l.depth == self.depth()))
        {
            return None;
        }
        let mut depth = self.to.depth;
        let mut after = self.to.after(depth);
        while depth > 1 {
            depth -= 1;
            if after != self.to.end(depth) {
                break;
            }
            after += 1;
        }
        Some(after)
    }

    fn find_close_level(&self, to: &ResolvedPos) -> Option<CloseLevel> {
        'scan: for i in (0..=self.depth().min(to.depth)).rev() {
            let Frontier { ty, m } = &self.frontier[i];
            let drop_inner = i < to.depth && to.end(i + 1) == to.pos + (to.depth - (i + 1));
            let Some(fit) = content_after_fits(to, i, ty, m, drop_inner) else {
                continue;
            };
            for d in (0..i).rev() {
                let f = &self.frontier[d];
                match content_after_fits(to, d, &f.ty, &f.m, true) {
                    Some(m) if m.child_count() == 0 => {}
                    _ => continue 'scan,
                }
            }
            let mv = if drop_inner {
                to.doc().resolve(to.after(i + 1)).ok()?
            } else {
                to.clone()
            };
            return Some(CloseLevel { depth: i, fit, mv });
        }
        None
    }

    fn close(&mut self, to: ResolvedPos) -> Option<ResolvedPos> {
        let close = self.find_close_level(&to)?;
        while self.depth() > close.depth {
            self.close_frontier_node();
        }
        if close.fit.child_count() > 0 {
            self.placed = add_to_fragment(&self.placed, close.depth, &close.fit);
        }
        let to = close.mv;
        for d in close.depth + 1..=to.depth {
            let node = to.node(d).clone();
            let add = node
                .ty()
                .content_match()
                .fill_before(node.content(), true, to.index(d))?;
            self.open_frontier_node(node.ty().clone(), Some(node.attrs().clone()), Some(add))?;
        }
        Some(to)
    }

    fn open_frontier_node(
        &mut self,
        ty: NodeType,
        attrs: Option<Attrs>,
        content: Option<Fragment>,
    ) -> Option<()> {
        let depth = self.depth();
        let top = &mut self.frontier[depth];
        top.m = top.m.match_type(&ty)?;
        let node = ty
            .create(attrs, content.unwrap_or_else(Fragment::empty), Vec::new())
            .ok()?;
        self.placed = add_to_fragment(&self.placed, depth, &frag1(node));
        let m = ty.content_match();
        self.frontier.push(Frontier { ty, m });
        Some(())
    }

    fn close_frontier_node(&mut self) {
        let Some(open) = self.frontier.pop() else {
            return;
        };
        if let Some(add) = open.m.fill_before(&Fragment::empty(), true, 0)
            && add.child_count() > 0
        {
            self.placed = add_to_fragment(&self.placed, self.frontier.len(), &add);
        }
    }
}

fn drop_from_fragment(fragment: &Fragment, depth: usize, count: usize) -> Fragment {
    if depth == 0 {
        return cut_by_index(
            fragment,
            count.min(fragment.child_count()),
            fragment.child_count(),
        );
    }
    let first = fragment.child(0).clone();
    fragment.replace_child(
        0,
        first.copy(drop_from_fragment(first.content(), depth - 1, count)),
    )
}

fn add_to_fragment(fragment: &Fragment, depth: usize, content: &Fragment) -> Fragment {
    if depth == 0 {
        return fragment.append(content);
    }
    let last_index = fragment.child_count() - 1;
    let last = fragment.child(last_index).clone();
    fragment.replace_child(
        last_index,
        last.copy(add_to_fragment(last.content(), depth - 1, content)),
    )
}

fn content_at(fragment: &Fragment, depth: usize) -> Fragment {
    let mut fragment = fragment.clone();
    for _ in 0..depth {
        fragment = fragment.child(0).content().clone();
    }
    fragment
}

fn close_node_start(node: Node, open_start: isize, open_end: isize) -> Node {
    if open_start <= 0 {
        return node;
    }
    let mut frag = node.content().clone();
    if open_start > 1 {
        let first = frag.child(0).clone();
        let inner_end = if frag.child_count() == 1 {
            open_end - 1
        } else {
            0
        };
        frag = frag.replace_child(0, close_node_start(first, open_start - 1, inner_end));
    }
    let cm = node.ty().content_match();
    if let Some(before) = cm.fill_before(&frag, false, 0) {
        frag = before.append(&frag);
    }
    if open_end <= 0
        && let Some(after) =
            match_all(&cm, &frag).and_then(|m| m.fill_before(&Fragment::empty(), true, 0))
    {
        frag = frag.append(&after);
    }
    node.copy(frag)
}

fn content_after_fits(
    to: &ResolvedPos,
    depth: usize,
    ty: &NodeType,
    m: &ContentMatch,
    open: bool,
) -> Option<Fragment> {
    let node = to.node(depth);
    let index = if open {
        to.index_after(depth)
    } else {
        to.index(depth)
    };
    if index == node.child_count() && !ty.compatible_content(node.ty()) {
        return None;
    }
    let fit = m.fill_before(node.content(), true, index)?;
    (!invalid_marks(ty, node.content(), index)).then_some(fit)
}

fn invalid_marks(ty: &NodeType, fragment: &Fragment, start: usize) -> bool {
    (start..fragment.child_count()).any(|i| !allows_marks(ty, fragment.child(i).marks()))
}

fn max_open(fragment: &Fragment, end: bool) -> usize {
    let mut fragment = fragment.clone();
    let mut count = 0;
    loop {
        if fragment.child_count() == 0 {
            return count;
        }
        let ch = fragment
            .child(if end { fragment.child_count() - 1 } else { 0 })
            .clone();
        if ch.is_atom() {
            return count;
        }
        fragment = ch.content().clone();
        count += 1;
    }
}

/// [`Transform::replace_range`].
pub(crate) fn replace_range(
    tr: &mut Transform,
    mut from: usize,
    mut to: usize,
    slice: &Slice,
) -> Result<(), StepError> {
    if slice.size() == 0 {
        return delete_range(tr, from, to);
    }
    let rf = resolve(&tr.doc, from)?;
    let rt = resolve(&tr.doc, to)?;
    if fits_trivially(&rf, &rt, slice) {
        tr.step(Box::new(ReplaceStep::new(from, to, slice.clone(), false)))?;
        return Ok(());
    }

    let mut target_depths: Vec<isize> = covered_depths(&rf, &rt)
        .into_iter()
        .map(|d| d as isize)
        .collect();
    // The whole document is never replaced.
    if target_depths.last() == Some(&0) {
        target_depths.pop();
    }
    // A negative depth -D replaces from `rf.before(D)` to `to` instead of
    // the whole node at D.
    let mut preferred_target = -(rf.depth as isize + 1);
    target_depths.insert(0, preferred_target);
    // Prefer a covering depth not outside a defining node, and add
    // negative depths for those `rf` starts that cross no defining node.
    let mut pos = rf.pos as isize - 1;
    for d in (1..=rf.depth).rev() {
        let spec = rf.node(d).ty().spec().clone();
        if spec.defining || spec.defining_as_context == Some(true) || spec.isolating {
            break;
        }
        if target_depths.contains(&(d as isize)) {
            preferred_target = d as isize;
        } else if rf.before(d) as isize == pos {
            target_depths.insert(1, -(d as isize));
        }
        pos -= 1;
    }
    let preferred_index = target_depths
        .iter()
        .position(|&d| d == preferred_target)
        .unwrap_or(0);

    let mut left_nodes: Vec<Node> = Vec::new();
    let mut preferred_depth = slice.open_start;
    let mut content = slice.content.clone();
    let mut i = 0;
    loop {
        if content.child_count() == 0 {
            break;
        }
        let node = content.child(0).clone();
        left_nodes.push(node.clone());
        if i == slice.open_start {
            break;
        }
        content = node.content().clone();
        i += 1;
    }

    // Back preferred_depth up over defining textblocks right above it,
    // possibly skipping a non-defining textblock.
    for d in (0..preferred_depth).rev() {
        let Some(left) = left_nodes.get(d) else { break };
        let def = left.ty().spec().defining || left.ty().spec().defining_for_content == Some(true);
        let context = rf.node(preferred_target.unsigned_abs() - 1);
        if def && !left.same_markup(context) {
            preferred_depth = d;
        } else if def || !left.ty().is_textblock() {
            break;
        }
    }

    for j in (0..=slice.open_start).rev() {
        let open_depth = (j + preferred_depth + 1) % (slice.open_start + 1);
        let Some(insert) = left_nodes.get(open_depth) else {
            continue;
        };
        for i in 0..target_depths.len() {
            // Expansion levels, the preferred one first.
            let mut target = target_depths[(i + preferred_index) % target_depths.len()];
            let mut expand = true;
            if target < 0 {
                expand = false;
                target = -target;
            }
            let target = target as usize;
            let parent = rf.node(target - 1);
            let index = rf.index(target - 1);
            if parent.can_replace_with(index, index, insert.ty(), Some(insert.marks())) {
                let content = close_fragment(&slice.content, 0, slice.open_start, open_depth, None);
                tr.replace(
                    rp_before(&rf, target),
                    if expand { rp_after(&rt, target) } else { to },
                    Slice {
                        content,
                        open_start: open_depth,
                        open_end: slice.open_end,
                    },
                )?;
                return Ok(());
            }
        }
    }

    let start_steps = tr.steps.len();
    for i in (0..target_depths.len()).rev() {
        tr.replace(from, to, slice.clone())?;
        if tr.steps.len() > start_steps {
            break;
        }
        let depth = target_depths[i];
        if depth < 0 {
            continue;
        }
        from = rp_before(&rf, depth as usize);
        to = rp_after(&rt, depth as usize);
    }
    Ok(())
}

fn close_fragment(
    fragment: &Fragment,
    depth: usize,
    old_open: usize,
    new_open: usize,
    parent: Option<&Node>,
) -> Fragment {
    let mut fragment = fragment.clone();
    if depth < old_open && fragment.child_count() > 0 {
        let first = fragment.child(0).clone();
        let inner = close_fragment(first.content(), depth + 1, old_open, new_open, Some(&first));
        fragment = fragment.replace_child(0, first.copy(inner));
    }
    if depth > new_open
        && let Some(m) = parent.and_then(|p| p.content_match_at(0))
    {
        let start = match m.fill_before(&fragment, false, 0) {
            Some(before) => before.append(&fragment),
            None => fragment.clone(),
        };
        fragment =
            match match_all(&m, &start).and_then(|m| m.fill_before(&Fragment::empty(), true, 0)) {
                Some(after) => start.append(&after),
                None => start,
            };
    }
    fragment
}

/// [`Transform::replace_range_with`].
pub(crate) fn replace_range_with(
    tr: &mut Transform,
    mut from: usize,
    mut to: usize,
    node: Node,
) -> Result<(), StepError> {
    if !node.is_inline()
        && from == to
        && resolve(&tr.doc, from)?.parent().content().size() > 0
        && let Some(point) = insert_point(&tr.doc, from, node.ty())
    {
        from = point;
        to = point;
    }
    replace_range(
        tr,
        from,
        to,
        &Slice {
            content: frag1(node),
            open_start: 0,
            open_end: 0,
        },
    )
}

/// [`Transform::delete_range`].
pub(crate) fn delete_range(
    tr: &mut Transform,
    mut from: usize,
    mut to: usize,
) -> Result<(), StepError> {
    let mut rf = resolve(&tr.doc, from)?;
    let mut rt = resolve(&tr.doc, to)?;

    // A range from the start of one textblock to the start of another
    // moves out of the start of both.
    if rf.parent().is_textblock()
        && rt.parent().is_textblock()
        && rf.start(rf.depth) != rt.start(rt.depth)
        && rf.parent_offset == 0
        && rt.parent_offset == 0
    {
        let shared = rf.shared_depth(to);
        let isolated = (shared + 1..=rf.depth).any(|d| rf.node(d).ty().spec().isolating)
            || (shared + 1..=rt.depth).any(|d| rt.node(d).ty().spec().isolating);
        if !isolated {
            let mut d = rf.depth;
            while d > 0 && from == rf.start(d) {
                from = rf.before(d);
                d -= 1;
            }
            let mut d = rt.depth;
            while d > 0 && to == rt.start(d) {
                to = rt.before(d);
                d -= 1;
            }
            rf = resolve(&tr.doc, from)?;
            rt = resolve(&tr.doc, to)?;
        }
    }

    let covered = covered_depths(&rf, &rt);
    for (i, &depth) in covered.iter().enumerate() {
        let last = i == covered.len() - 1;
        if (last && depth == 0) || rf.node(depth).ty().content_match().valid_end() {
            tr.delete(rf.start(depth), rt.end(depth))?;
            return Ok(());
        }
        if depth > 0
            && (last
                || rf.node(depth - 1).can_replace(
                    rf.index(depth - 1),
                    rt.index_after(depth - 1),
                    &Fragment::empty(),
                    0,
                    0,
                ))
        {
            tr.delete(rf.before(depth), rt.after(depth))?;
            return Ok(());
        }
    }
    let mut d = 1;
    while d <= rf.depth && d <= rt.depth {
        if from - rf.start(d) == rf.depth - d
            && to > rf.end(d)
            && rt.end(d) - to != rt.depth - d
            && rf.start(d - 1) == rt.start(d - 1)
            && rf.node(d - 1).can_replace(
                rf.index(d - 1),
                rt.index(d - 1),
                &Fragment::empty(),
                0,
                0,
            )
        {
            tr.delete(rf.before(d), to)?;
            return Ok(());
        }
        d += 1;
    }
    tr.delete(from, to)?;
    Ok(())
}

/// The depths whose whole content `rf..rt` spans.
fn covered_depths(rf: &ResolvedPos, rt: &ResolvedPos) -> Vec<usize> {
    let mut result = Vec::new();
    for d in (0..=rf.depth.min(rt.depth)).rev() {
        let start = rf.start(d);
        if start + (rf.depth - d) < rf.pos
            || rt.end(d) > rt.pos + (rt.depth - d)
            || rf.node(d).ty().spec().isolating
            || rt.node(d).ty().spec().isolating
        {
            break;
        }
        if start == rt.start(d)
            || (d == rf.depth
                && d == rt.depth
                && rf.parent().is_textblock()
                && rt.parent().is_textblock()
                && d > 0
                && rt.start(d - 1) + 1 == start)
        {
            result.push(d);
        }
    }
    result
}
