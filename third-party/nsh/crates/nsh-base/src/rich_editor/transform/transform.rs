//! [`Transform`]: steps applied one after another to a document, with
//! their documents and mapping, and the editing methods built on them
//! (prosemirror-transform's `transform.ts` and `mark.ts`).

use serde_json::Value;

use super::{
    attr_step::{AttrStep, DocAttrStep},
    map::Mapping,
    mark_step::{AddMarkStep, AddNodeMarkStep, RemoveMarkStep, RemoveNodeMarkStep},
    replace::{self, allowed_marks, frag1, replace_step},
    replace_step::ReplaceStep,
    step::{BoxStep, StepError, StepResult},
    structure::{self, TypeAfter},
};
use crate::rich_editor::model::{
    Attrs, ContentMatch, Fragment, Mark, MarkType, Node, NodeRange, NodeType, Slice,
};

/// Which marks [`Transform::remove_mark`] and
/// [`Transform::remove_node_mark`] remove.
#[derive(Clone, Debug)]
pub enum MarkMatch {
    /// Exactly this mark.
    Mark(Mark),
    /// Every mark of this type.
    Type(MarkType),
    /// Every mark.
    All,
}

impl From<Mark> for MarkMatch {
    fn from(mark: Mark) -> Self {
        Self::Mark(mark)
    }
}

impl From<MarkType> for MarkMatch {
    fn from(ty: MarkType) -> Self {
        Self::Type(ty)
    }
}

impl From<Option<MarkType>> for MarkMatch {
    fn from(ty: Option<MarkType>) -> Self {
        ty.map_or(Self::All, Self::Type)
    }
}

/// A document and the steps that changed it, in order.
#[derive(Clone, Debug)]
pub struct Transform {
    /// The current document: the result of the steps.
    pub doc: Node,
    /// The steps applied.
    pub steps: Vec<BoxStep>,
    /// The document before each step.
    pub docs: Vec<Node>,
    /// The maps of the steps.
    pub mapping: Mapping,
}

impl Transform {
    /// A transform starting at `doc`.
    pub fn new(doc: Node) -> Self {
        Self {
            doc,
            steps: Vec::new(),
            docs: Vec::new(),
            mapping: Mapping::new(),
        }
    }

    /// The document the transform started with.
    pub fn before(&self) -> &Node {
        self.docs.first().unwrap_or(&self.doc)
    }

    /// The current document.
    pub fn doc(&self) -> &Node {
        &self.doc
    }

    /// Whether any step was applied.
    pub fn doc_changed(&self) -> bool {
        !self.steps.is_empty()
    }

    /// Applies a step; on failure nothing changes.
    pub fn step(&mut self, step: BoxStep) -> Result<&mut Self, StepError> {
        let doc = step.apply(&self.doc)?;
        self.add_step(step, doc);
        Ok(self)
    }

    /// Applies a step when it applies, returning its result either way.
    pub fn maybe_step(&mut self, step: BoxStep) -> StepResult {
        let result = step.apply(&self.doc);
        if let Ok(doc) = &result {
            self.add_step(step, doc.clone());
        }
        result
    }

    /// Records a step already applied, `doc` being its result.
    pub fn add_step(&mut self, step: BoxStep, doc: Node) {
        self.docs.push(std::mem::replace(&mut self.doc, doc));
        self.mapping.append_map(step.get_map(), None);
        self.steps.push(step);
    }

    /// The range, in the current document, that covers everything the
    /// steps replaced (mark-only changes do not count); `None` when
    /// nothing was replaced.
    pub fn changed_range(&self) -> Option<(usize, usize)> {
        let (mut from, mut to): (isize, isize) = (isize::MAX, isize::MIN);
        for (i, map) in self.mapping.maps.iter().enumerate() {
            if i > 0 && from != isize::MAX {
                from = map.map(from as usize, 1) as isize;
                to = map.map(to.max(0) as usize, -1) as isize;
            }
            map.for_each(|_, _, new_from, new_to| {
                from = from.min(new_from as isize);
                to = to.max(new_to as isize);
            });
        }
        (from != isize::MAX).then_some((from as usize, to as usize))
    }

    /// Runs a compound edit; when it fails, the transform is put back as
    /// it was before it, so every method is all or nothing.
    fn atomic(
        &mut self,
        f: impl FnOnce(&mut Self) -> Result<(), StepError>,
    ) -> Result<&mut Self, StepError> {
        let (len, doc) = (self.steps.len(), self.doc.clone());
        if let Err(e) = f(self) {
            self.steps.truncate(len);
            self.docs.truncate(len);
            self.mapping.truncate(len);
            self.doc = doc;
            return Err(e);
        }
        Ok(self)
    }

    /// Replaces `from..to` with `slice`, fitting it with
    /// [`replace_step`]; does nothing when that finds no step.
    pub fn replace(
        &mut self,
        from: usize,
        to: usize,
        slice: Slice,
    ) -> Result<&mut Self, StepError> {
        if from > to || to > self.doc.content().size() {
            return Err(StepError::Invalid(format!(
                "range {from}..{to} out of the document"
            )));
        }
        match replace_step(&self.doc, from, to, &slice) {
            Some(step) => self.step(step),
            None => Ok(self),
        }
    }

    /// Replaces `from..to` with `content`.
    pub fn replace_with(
        &mut self,
        from: usize,
        to: usize,
        content: Fragment,
    ) -> Result<&mut Self, StepError> {
        self.replace(
            from,
            to,
            Slice {
                content,
                open_start: 0,
                open_end: 0,
            },
        )
    }

    /// Replaces `from..to` with one node.
    pub fn replace_with_node(
        &mut self,
        from: usize,
        to: usize,
        node: Node,
    ) -> Result<&mut Self, StepError> {
        self.replace_with(from, to, frag1(node))
    }

    /// Deletes `from..to`.
    pub fn delete(&mut self, from: usize, to: usize) -> Result<&mut Self, StepError> {
        self.replace(from, to, Slice::empty())
    }

    /// Inserts `content` at `pos`.
    pub fn insert(&mut self, pos: usize, content: Fragment) -> Result<&mut Self, StepError> {
        self.replace_with(pos, pos, content)
    }

    /// Inserts one node at `pos`.
    pub fn insert_node(&mut self, pos: usize, node: Node) -> Result<&mut Self, StepError> {
        self.replace_with(pos, pos, frag1(node))
    }

    /// Replaces a range with a slice, taking `from`, `to` and the
    /// slice's open start as hints: it may grow the range over covered
    /// non-defining parents or keep a defining open parent of the slice,
    /// as pasting wants.
    pub fn replace_range(
        &mut self,
        from: usize,
        to: usize,
        slice: Slice,
    ) -> Result<&mut Self, StepError> {
        self.atomic(|tr| replace::replace_range(tr, from, to, &slice))
    }

    /// Replaces a range with a node, moving an empty range out of parents
    /// that do not allow it and replacing parents it covers whole.
    pub fn replace_range_with(
        &mut self,
        from: usize,
        to: usize,
        node: Node,
    ) -> Result<&mut Self, StepError> {
        self.atomic(|tr| replace::replace_range_with(tr, from, to, node))
    }

    /// Deletes a range, growing it over covered parents until the
    /// deletion is valid.
    pub fn delete_range(&mut self, from: usize, to: usize) -> Result<&mut Self, StepError> {
        self.atomic(|tr| replace::delete_range(tr, from, to))
    }

    /// Lifts the content of `range` out of its parents up to `target`
    /// (see [`lift_target`](super::lift_target)).
    pub fn lift(&mut self, range: &NodeRange, target: usize) -> Result<&mut Self, StepError> {
        self.atomic(|tr| structure::lift(tr, range, target))
    }

    /// Joins the blocks around `pos`, and `depth - 1` levels of their last
    /// and first descendants.
    pub fn join(&mut self, pos: usize, depth: usize) -> Result<&mut Self, StepError> {
        self.atomic(|tr| structure::join(tr, pos, depth))
    }

    /// Wraps `range` in `wrappers`, outermost first (see
    /// [`find_wrapping`](super::find_wrapping)).
    pub fn wrap(
        &mut self,
        range: &NodeRange,
        wrappers: &[(NodeType, Option<Attrs>)],
    ) -> Result<&mut Self, StepError> {
        self.atomic(|tr| structure::wrap(tr, range, wrappers))
    }

    /// Makes every textblock in `from..to` a `ty` with `attrs`.
    pub fn set_block_type(
        &mut self,
        from: usize,
        to: usize,
        ty: &NodeType,
        attrs: Option<Attrs>,
    ) -> Result<&mut Self, StepError> {
        self.atomic(|tr| structure::set_block_type(tr, from, to, ty, &|_| attrs.clone()))
    }

    /// [`set_block_type`](Self::set_block_type) with attributes computed
    /// from each old node.
    pub fn set_block_type_with(
        &mut self,
        from: usize,
        to: usize,
        ty: &NodeType,
        attrs: &dyn Fn(&Node) -> Option<Attrs>,
    ) -> Result<&mut Self, StepError> {
        self.atomic(|tr| structure::set_block_type(tr, from, to, ty, attrs))
    }

    /// Changes the type (`None` keeps it), attributes and marks (`None`
    /// keeps them) of the node at `pos`.
    pub fn set_node_markup(
        &mut self,
        pos: usize,
        ty: Option<NodeType>,
        attrs: Option<Attrs>,
        marks: Option<Vec<Mark>>,
    ) -> Result<&mut Self, StepError> {
        self.atomic(|tr| structure::set_node_markup(tr, pos, ty, attrs, marks))
    }

    /// Sets one attribute of the node at `pos`.
    pub fn set_node_attribute(
        &mut self,
        pos: usize,
        attr: &str,
        value: Value,
    ) -> Result<&mut Self, StepError> {
        self.step(Box::new(AttrStep::new(pos, attr, value)))
    }

    /// Sets one attribute of the document.
    pub fn set_doc_attribute(&mut self, attr: &str, value: Value) -> Result<&mut Self, StepError> {
        self.step(Box::new(DocAttrStep::new(attr, value)))
    }

    /// Adds a mark to the node at `pos`.
    pub fn add_node_mark(&mut self, pos: usize, mark: Mark) -> Result<&mut Self, StepError> {
        self.step(Box::new(AddNodeMarkStep::new(pos, mark)))
    }

    /// Removes a mark, the marks of a type, or all marks from the node at
    /// `pos`.
    pub fn remove_node_mark(
        &mut self,
        pos: usize,
        mark: MarkMatch,
    ) -> Result<&mut Self, StepError> {
        let node = self
            .doc
            .node_at(pos)
            .ok_or_else(|| StepError::Invalid(format!("no node at position {pos}")))?;
        let to_remove: Vec<Mark> = match mark {
            MarkMatch::Mark(m) => {
                if m.is_in_set(node.marks()) {
                    vec![m]
                } else {
                    vec![]
                }
            }
            MarkMatch::Type(t) => node.marks().iter().filter(|m| m.ty == t).cloned().collect(),
            MarkMatch::All => node.marks().to_vec(),
        };
        self.atomic(|tr| {
            for m in to_remove.into_iter().rev() {
                tr.step(Box::new(RemoveNodeMarkStep::new(pos, m)))?;
            }
            Ok(())
        })
    }

    /// Splits the node at `pos`, and `depth - 1` of its ancestors; the
    /// split-off nodes take `types_after`'s types (outermost first), an
    /// entry or a missing list keeping the original's.
    pub fn split(
        &mut self,
        pos: usize,
        depth: usize,
        types_after: Option<Vec<TypeAfter>>,
    ) -> Result<&mut Self, StepError> {
        let types = types_after.unwrap_or_default();
        self.atomic(|tr| structure::split(tr, pos, depth, &types))
    }

    /// Adds `mark` to the inline content in `from..to`, removing marks it
    /// excludes.
    pub fn add_mark(&mut self, from: usize, to: usize, mark: Mark) -> Result<&mut Self, StepError> {
        self.atomic(|tr| add_mark(tr, from, to, &mark))
    }

    /// Removes marks from the inline content in `from..to`.
    pub fn remove_mark(
        &mut self,
        from: usize,
        to: usize,
        mark: MarkMatch,
    ) -> Result<&mut Self, StepError> {
        self.atomic(|tr| remove_mark(tr, from, to, &mark))
    }

    /// Removes the children and marks of the node at `pos` that a
    /// `parent_type` parent does not allow (starting at `start_match`
    /// when given), and fills what its content then lacks.
    pub fn clear_incompatible(
        &mut self,
        pos: usize,
        parent_type: &NodeType,
        start_match: Option<ContentMatch>,
    ) -> Result<&mut Self, StepError> {
        self.atomic(|tr| clear_incompatible(tr, pos, parent_type, start_match, true))
    }
}

fn add_mark(tr: &mut Transform, from: usize, to: usize, mark: &Mark) -> Result<(), StepError> {
    let mut removed: Vec<RemoveMarkStep> = Vec::new();
    let mut added: Vec<AddMarkStep> = Vec::new();
    let mut removing: Option<usize> = None;
    let mut adding: Option<usize> = None;
    let doc = tr.doc.clone();
    doc.nodes_between(
        from,
        to,
        &mut |node: &Node, pos: usize, parent: Option<&Node>, _: usize| {
            if !node.is_inline() {
                return true;
            }
            let marks = node.marks();
            if !mark.is_in_set(marks) && parent.is_some_and(|p| p.ty().allows_mark_type(&mark.ty)) {
                let start = pos.max(from);
                let end = (pos + node.node_size()).min(to);
                let new_set = mark.add_to_set(marks);
                for m in marks {
                    if !m.is_in_set(&new_set) {
                        match removing {
                            Some(r) if removed[r].to == start && removed[r].mark == *m => {
                                removed[r].to = end
                            }
                            _ => {
                                removed.push(RemoveMarkStep::new(start, end, m.clone()));
                                removing = Some(removed.len() - 1);
                            }
                        }
                    }
                }
                match adding {
                    Some(a) if added[a].to == start => added[a].to = end,
                    _ => {
                        added.push(AddMarkStep::new(start, end, mark.clone()));
                        adding = Some(added.len() - 1);
                    }
                }
            }
            true
        },
    );
    for s in removed {
        tr.step(Box::new(s))?;
    }
    for s in added {
        tr.step(Box::new(s))?;
    }
    Ok(())
}

fn remove_mark(
    tr: &mut Transform,
    from: usize,
    to: usize,
    mark: &MarkMatch,
) -> Result<(), StepError> {
    struct Matched {
        style: Mark,
        from: usize,
        to: usize,
        step: usize,
    }
    let mut matched: Vec<Matched> = Vec::new();
    let mut step = 0;
    let doc = tr.doc.clone();
    doc.nodes_between(
        from,
        to,
        &mut |node: &Node, pos: usize, _: Option<&Node>, _: usize| {
            if !node.is_inline() {
                return true;
            }
            step += 1;
            let to_remove: Vec<Mark> = match mark {
                MarkMatch::Type(t) => node
                    .marks()
                    .iter()
                    .filter(|m| m.ty == *t)
                    .cloned()
                    .collect(),
                MarkMatch::Mark(m) => {
                    if m.is_in_set(node.marks()) {
                        vec![m.clone()]
                    } else {
                        vec![]
                    }
                }
                MarkMatch::All => node.marks().to_vec(),
            };
            let end = (pos + node.node_size()).min(to);
            for style in to_remove {
                // Extend the range of the same mark on the previous inline node.
                if let Some(found) = matched
                    .iter_mut()
                    .rev()
                    .find(|m| m.step + 1 == step && m.style == style)
                {
                    found.to = end;
                    found.step = step;
                } else {
                    matched.push(Matched {
                        style,
                        from: pos.max(from),
                        to: end,
                        step,
                    });
                }
            }
            true
        },
    );
    for m in matched {
        tr.step(Box::new(RemoveMarkStep::new(m.from, m.to, m.style)))?;
    }
    Ok(())
}

/// The UTF-16 offsets and lengths of the line breaks (`\r\n`, `\r`,
/// `\n`) in `text`.
pub(crate) fn newlines(text: &str) -> Vec<(usize, usize)> {
    let mut result = Vec::new();
    let mut offset = 0;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' if chars.peek() == Some(&'\n') => {
                chars.next();
                result.push((offset, 2));
                offset += 2;
            }
            '\r' | '\n' => {
                result.push((offset, 1));
                offset += 1;
            }
            c => offset += c.len_utf16(),
        }
    }
    result
}

pub(crate) fn clear_incompatible(
    tr: &mut Transform,
    pos: usize,
    parent_type: &NodeType,
    start_match: Option<ContentMatch>,
    clear_newlines: bool,
) -> Result<(), StepError> {
    let node = tr
        .doc
        .node_at(pos)
        .ok_or_else(|| StepError::Invalid(format!("no node at position {pos}")))?;
    let mut m = start_match.unwrap_or_else(|| parent_type.content_match());
    let mut repl: Vec<ReplaceStep> = Vec::new();
    let mut cur = pos + 1;
    for i in 0..node.child_count() {
        let child = node.child(i).clone();
        let end = cur + child.node_size();
        match m.match_type(child.ty()) {
            None => repl.push(ReplaceStep::new(cur, end, Slice::empty(), false)),
            Some(allowed) => {
                m = allowed;
                for mark in child.marks() {
                    if !parent_type.allows_mark_type(&mark.ty) {
                        tr.step(Box::new(RemoveMarkStep::new(cur, end, mark.clone())))?;
                    }
                }
                // Code blocks keep their line breaks (ProseMirror's
                // `whitespace: "pre"`).
                if clear_newlines && child.is_text() && parent_type.whitespace() != "pre" {
                    let text = child.text().unwrap_or_default().to_owned();
                    for (index, len) in newlines(&text) {
                        let space = child
                            .with_text(" ")
                            .mark(allowed_marks(parent_type, child.marks()));
                        let slice = Slice {
                            content: frag1(space),
                            open_start: 0,
                            open_end: 0,
                        };
                        repl.push(ReplaceStep::new(
                            cur + index,
                            cur + index + len,
                            slice,
                            false,
                        ));
                    }
                }
            }
        }
        cur = end;
    }
    if !m.valid_end()
        && let Some(fill) = m.fill_before(&Fragment::empty(), true, 0)
    {
        tr.replace(
            cur,
            cur,
            Slice {
                content: fill,
                open_start: 0,
                open_end: 0,
            },
        )?;
    }
    for s in repl.into_iter().rev() {
        tr.step(Box::new(s))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rich_editor::{
        model::{MarkSpec, NodeSpec, Schema, SchemaSpec},
        transform::{
            Step, StepRegistry, can_join, can_split, find_wrapping, lift_target, step_from_json,
        },
    };

    fn node(content: Option<&str>, group: Option<&str>) -> NodeSpec {
        NodeSpec {
            content: content.map(Into::into),
            group: group.map(Into::into),
            ..NodeSpec::default()
        }
    }

    fn schema() -> Schema {
        let text = NodeSpec {
            group: Some("inline".into()),
            inline: true,
            ..NodeSpec::default()
        };
        let mut code = node(Some("text*"), Some("block"));
        code.code = true;
        code.marks = Some(String::new());
        let spec = SchemaSpec {
            nodes: vec![
                ("doc".into(), node(Some("block+"), None)),
                ("paragraph".into(), node(Some("inline*"), Some("block"))),
                ("blockquote".into(), node(Some("block+"), Some("block"))),
                ("code_block".into(), code),
                (
                    "bullet_list".into(),
                    node(Some("list_item+"), Some("block")),
                ),
                ("list_item".into(), node(Some("paragraph block*"), None)),
                ("text".into(), text),
                ("hard_break".into(), {
                    let mut br = node(None, Some("inline"));
                    br.inline = true;
                    br.linebreak_replacement = true;
                    br
                }),
            ],
            marks: vec![
                ("em".into(), MarkSpec::default()),
                ("strong".into(), MarkSpec::default()),
            ],
            ..SchemaSpec::default()
        };
        Schema::new(spec).unwrap()
    }

    fn el(s: &Schema, name: &str, children: Vec<Node>) -> Node {
        s.node(name, None, Fragment::from(children), vec![])
            .unwrap()
    }

    fn p(s: &Schema, text: &str) -> Node {
        el(
            s,
            "paragraph",
            if text.is_empty() {
                vec![]
            } else {
                vec![s.text(text, vec![])]
            },
        )
    }

    fn mark(s: &Schema, name: &str) -> Mark {
        s.mark(name, None).unwrap()
    }

    /// Checks every step inverts back to the document before it and
    /// survives a JSON roundtrip.
    fn check_invert(s: &Schema, tr: &Transform) {
        for (i, step) in tr.steps.iter().enumerate() {
            let after = if i + 1 < tr.docs.len() {
                tr.docs[i + 1].clone()
            } else {
                tr.doc.clone()
            };
            let inverted = step.invert(&tr.docs[i]);
            assert_eq!(
                inverted.apply(&after).unwrap(),
                tr.docs[i],
                "step {i} inverts"
            );
            let back = step_from_json(s, &step.to_json()).unwrap();
            assert_eq!(back.to_json(), step.to_json());
            assert_eq!(back.apply(&tr.docs[i]).unwrap(), after);
        }
    }

    #[test]
    fn replace_and_invert() {
        let s = schema();
        let doc = el(&s, "doc", vec![p(&s, "hello"), p(&s, "world")]);
        let mut tr = Transform::new(doc.clone());
        tr.delete(3, 10).unwrap();
        assert_eq!(tr.doc, el(&s, "doc", vec![p(&s, "herld")]));
        tr.insert(1, frag1(s.text("X", vec![]))).unwrap();
        assert_eq!(tr.doc.text_content(), "Xherld");
        assert_eq!(tr.before(), &doc);
        check_invert(&s, &tr);
        assert_eq!(tr.mapping.map(12, 1), 6);
    }

    #[test]
    fn failing_steps_change_nothing() {
        let s = schema();
        let doc = el(&s, "doc", vec![p(&s, "hi")]);
        let mut tr = Transform::new(doc.clone());
        // Closing the paragraph without opening one is invalid.
        let bad = ReplaceStep::new(
            1,
            1,
            Slice {
                content: frag1(p(&s, "")),
                open_start: 1,
                open_end: 0,
            },
            false,
        );
        assert!(tr.step(Box::new(bad)).is_err());
        assert!(!tr.doc_changed());
        assert_eq!(tr.doc, doc);
        assert!(tr.delete(2, 99).is_err());
        assert!(!tr.doc_changed());
    }

    #[test]
    fn split_and_join() {
        let s = schema();
        let doc = el(&s, "doc", vec![p(&s, "hello")]);
        assert!(can_split(&doc, 3, 1, None));
        let mut tr = Transform::new(doc.clone());
        tr.split(3, 1, None).unwrap();
        assert_eq!(tr.doc, el(&s, "doc", vec![p(&s, "he"), p(&s, "llo")]));
        assert!(can_join(&tr.doc, 4));
        tr.join(4, 1).unwrap();
        assert_eq!(tr.doc, doc);
        check_invert(&s, &tr);
    }

    #[test]
    fn wrap_and_lift() {
        let s = schema();
        let doc = el(&s, "doc", vec![p(&s, "a"), p(&s, "b")]);
        let rf = doc.resolve(1).unwrap();
        let rt = doc.resolve(4).unwrap();
        let range = rf.block_range(&rt, None).unwrap();
        let bq = s.node_type("blockquote").unwrap();
        let wrappers = find_wrapping(&range, &bq, None, None).unwrap();
        let mut tr = Transform::new(doc.clone());
        tr.wrap(&range, &wrappers).unwrap();
        assert_eq!(
            tr.doc,
            el(
                &s,
                "doc",
                vec![el(&s, "blockquote", vec![p(&s, "a"), p(&s, "b")])]
            )
        );

        let rf = tr.doc.resolve(2).unwrap();
        let rt = tr.doc.resolve(5).unwrap();
        let range = rf.block_range(&rt, None).unwrap();
        let target = lift_target(&range).unwrap();
        tr.lift(&range, target).unwrap();
        assert_eq!(tr.doc, doc);
        check_invert(&s, &tr);

        // Wrapping in a list adds the list item inside.
        let list = s.node_type("bullet_list").unwrap();
        let range = doc
            .resolve(1)
            .unwrap()
            .block_range(&doc.resolve(1).unwrap(), None)
            .unwrap();
        let wrappers = find_wrapping(&range, &list, None, None).unwrap();
        assert_eq!(wrappers.len(), 2);
    }

    #[test]
    fn marks_add_and_remove() {
        let s = schema();
        let doc = el(&s, "doc", vec![p(&s, "hello")]);
        let em = mark(&s, "em");
        let mut tr = Transform::new(doc.clone());
        tr.add_mark(2, 4, em.clone()).unwrap();
        assert!(tr.doc.range_has_mark(2, 4, &em.ty));
        assert!(!tr.doc.range_has_mark(4, 5, &em.ty));
        tr.add_mark(3, 6, em.clone()).unwrap();
        tr.remove_mark(1, 6, MarkMatch::Type(em.ty.clone()))
            .unwrap();
        assert_eq!(tr.doc, doc);
        check_invert(&s, &tr);
        // Steps merge.
        let a = AddMarkStep::new(1, 3, em.clone());
        let b = AddMarkStep::new(3, 5, em.clone());
        let merged = a.merge(&b).unwrap();
        assert_eq!(merged.to_json()["to"], 5);
    }

    #[test]
    fn set_block_type_and_attrs() {
        let s = schema();
        let strong = mark(&s, "strong");
        let doc = el(
            &s,
            "doc",
            vec![el(&s, "paragraph", vec![s.text("a\nb", vec![strong])])],
        );
        let code = s.node_type("code_block").unwrap();
        let mut tr = Transform::new(doc.clone());
        tr.set_block_type(1, 1, &code, None).unwrap();
        // Marks the code block does not allow are cleared.
        assert_eq!(
            tr.doc,
            el(
                &s,
                "doc",
                vec![el(&s, "code_block", vec![s.text("a\nb", vec![])])]
            )
        );
        let para = s.node_type("paragraph").unwrap();
        tr.set_block_type(1, 1, &para, None).unwrap();
        // Newlines become the schema's line break node outside code.
        assert_eq!(tr.doc.child(0).child_count(), 3);
        assert_eq!(tr.doc.child(0).child(1).ty().name(), "hard_break");
        check_invert(&s, &tr);
        // Attributes the schema does not declare are dropped, as
        // ProseMirror's `computeAttrs` drops them.
        tr.set_doc_attribute("x", Value::from(1)).unwrap();
        assert_eq!(tr.doc.attrs().get("x"), None);
    }

    #[test]
    fn set_block_type_converts_line_breaks() {
        let s = schema();
        let br = s
            .node("hard_break", None, Fragment::empty(), vec![])
            .unwrap();
        let para = |children| el(&s, "paragraph", children);
        let doc = el(
            &s,
            "doc",
            vec![para(vec![
                s.text("a", vec![]),
                br.clone(),
                s.text("b", vec![]),
            ])],
        );
        let code = s.node_type("code_block").unwrap();
        let mut tr = Transform::new(doc.clone());
        // Into a `pre` type without line break nodes: they become `\n`.
        tr.set_block_type(1, 1, &code, None).unwrap();
        assert_eq!(
            tr.doc,
            el(
                &s,
                "doc",
                vec![el(&s, "code_block", vec![s.text("a\nb", vec![])])]
            )
        );
        // Back into a normal type that allows them: `\n` becomes one.
        let p_ty = s.node_type("paragraph").unwrap();
        tr.set_block_type(1, 1, &p_ty, None).unwrap();
        assert_eq!(tr.doc, doc);
        check_invert(&s, &tr);
    }

    #[test]
    fn join_converts_line_breaks() {
        let s = schema();
        let br = s
            .node("hard_break", None, Fragment::empty(), vec![])
            .unwrap();
        let doc = el(
            &s,
            "doc",
            vec![
                el(&s, "code_block", vec![s.text("x", vec![])]),
                el(
                    &s,
                    "paragraph",
                    vec![s.text("a", vec![]), br, s.text("b", vec![])],
                ),
            ],
        );
        assert!(can_join(&doc, 3));
        let mut tr = Transform::new(doc);
        tr.join(3, 1).unwrap();
        assert_eq!(
            tr.doc,
            el(
                &s,
                "doc",
                vec![el(&s, "code_block", vec![s.text("xa\nb", vec![])])]
            )
        );
        check_invert(&s, &tr);
    }

    #[test]
    fn replace_range_and_delete_range() {
        let s = schema();
        let doc = el(&s, "doc", vec![p(&s, "one"), p(&s, "two")]);
        let mut tr = Transform::new(doc.clone());
        // Deleting from the start of one block to the start of the next
        // drops the first block.
        tr.delete_range(1, 6).unwrap();
        assert_eq!(tr.doc, el(&s, "doc", vec![p(&s, "two")]));
        let slice = doc.slice(2, 8, false).unwrap();
        let mut tr = Transform::new(doc.clone());
        tr.replace_range(1, 1, slice).unwrap();
        check_invert(&s, &tr);
        let mut tr = Transform::new(doc.clone());
        tr.replace_range_with(5, 5, p(&s, "new")).unwrap();
        assert_eq!(tr.doc.child_count(), 3);
        check_invert(&s, &tr);
    }

    #[test]
    fn mapped_steps_and_rebasing() {
        let s = schema();
        let doc = el(&s, "doc", vec![p(&s, "abcd")]);
        // Two concurrent edits: insert at 2, delete 3..5.
        let ins: BoxStep = Box::new(ReplaceStep::new(
            2,
            2,
            Slice {
                content: frag1(s.text("X", vec![])),
                open_start: 0,
                open_end: 0,
            },
            false,
        ));
        let del: BoxStep = Box::new(ReplaceStep::new(3, 5, Slice::empty(), false));
        let mut tr = Transform::new(doc.clone());
        tr.step(ins.clone()).unwrap();
        let mapped = del.map(&tr.mapping).unwrap();
        tr.step(mapped).unwrap();
        assert_eq!(tr.doc.text_content(), "aXb");
        // Undo the insert while keeping the delete: invert, map through
        // a mapping with mirrors.
        let mut mapping = Mapping::new();
        mapping.append_map(tr.steps[0].get_map().invert(), None);
        let mut redo = Transform::new(tr.doc.clone());
        let inv = tr.steps[0]
            .invert(&tr.docs[0])
            .map(&tr.mapping.slice(1, 2))
            .unwrap();
        redo.step(inv).unwrap();
        assert_eq!(redo.doc.text_content(), "ab");
    }

    #[test]
    fn registry_registers_custom_steps() {
        let mut registry = StepRegistry::new();
        assert!(registry.contains("replace"));
        assert!(registry.register("replace", step_from_json).is_err());
        registry
            .register("custom", |_, _| Err(StepError::Json("custom".into())))
            .unwrap();
        let s = schema();
        assert!(
            registry
                .from_json(&s, &serde_json::json!({"stepType": "custom"}))
                .is_err()
        );
        assert!(step_from_json(&s, &serde_json::json!({"stepType": "nope"})).is_err());
    }

    #[test]
    fn newline_offsets_count_utf16() {
        assert_eq!(newlines("a😀\r\nb\rc\n"), vec![(3, 2), (6, 1), (8, 1)]);
    }
}
