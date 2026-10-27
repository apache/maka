//! Selections, after `prosemirror-state`'s `selection.ts`: a text range
//! (with the head's visual [`Affinity`]), a selected node, the whole
//! document, or a kind the app defines ([`CustomSelection`]). Each maps
//! through changes and has a [`SelectionBookmark`] that history keeps
//! without holding a document.

use std::{fmt, sync::Arc};

use serde_json::{Value, json};

use super::{StateError, transaction::Transaction};
use crate::rich_editor::{
    model::{Node, ResolvedPos, Slice},
    transform::{Mappable, ReplaceAroundStep, ReplaceStep},
};

// The model's resolved positions are read through these, so a change in
// how it exposes them stays in one place.
fn pos_of(rp: &ResolvedPos) -> usize {
    rp.pos
}

fn depth_of(rp: &ResolvedPos) -> usize {
    rp.depth
}

fn has_inline_content(rp: &ResolvedPos) -> bool {
    rp.parent().ty().is_textblock()
}

fn resolve(doc: &Node, pos: usize) -> ResolvedPos {
    // Positions here come out of a mapping onto `doc` or are clamped to it,
    // so they are always inside it.
    doc.resolve(pos.min(doc.content().size()))
        .expect("a position inside the document")
}

/// The side of a cursor's position its caret is drawn on where both sides
/// are one position (a line wrap, a change of direction).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub enum Affinity {
    /// At the end of what comes before (the end of the upper line).
    Upstream,
    /// At the start of what comes after.
    #[default]
    Downstream,
}

impl Affinity {
    fn to_json(self) -> Value {
        match self {
            Self::Upstream => json!("upstream"),
            Self::Downstream => json!("downstream"),
        }
    }

    fn from_json(value: Option<&Value>) -> Self {
        match value.and_then(Value::as_str) {
            Some("upstream") => Self::Upstream,
            _ => Self::Downstream,
        }
    }
}

/// One selected range: what a selection covers, from its start to its end.
#[derive(Debug, Clone)]
pub struct SelectionRange {
    /// The start.
    pub from: ResolvedPos,
    /// The end.
    pub to: ResolvedPos,
}

impl SelectionRange {
    /// A range from `from` to `to`.
    pub fn new(from: ResolvedPos, to: ResolvedPos) -> Self {
        Self { from, to }
    }
}

/// A selection between two positions in inline content.
#[derive(Debug, Clone)]
pub struct TextSelection {
    anchor: ResolvedPos,
    head: ResolvedPos,
    affinity: Affinity,
    ranges: Vec<SelectionRange>,
}

impl TextSelection {
    /// A selection from `anchor` to `head`, both in inline content.
    pub fn new(anchor: ResolvedPos, head: ResolvedPos) -> Self {
        Self::with_affinity(anchor, head, Affinity::Downstream)
    }

    /// The same with the head's [`Affinity`].
    pub fn with_affinity(anchor: ResolvedPos, head: ResolvedPos, affinity: Affinity) -> Self {
        let (from, to) = if pos_of(&anchor) <= pos_of(&head) {
            (&anchor, &head)
        } else {
            (&head, &anchor)
        };
        let ranges = vec![SelectionRange::new(from.clone(), to.clone())];
        Self {
            anchor,
            head,
            affinity,
            ranges,
        }
    }

    /// A selection from `anchor` to `head` (`head` defaults to `anchor`) in
    /// `doc`.
    pub fn create(doc: &Node, anchor: usize, head: Option<usize>) -> Selection {
        let anchor = resolve(doc, anchor);
        let head = head.map_or_else(|| anchor.clone(), |head| resolve(doc, head));
        Self::new(anchor, head).into()
    }

    /// A text selection from `anchor` to `head`, moving either end that is
    /// not in inline content to the nearest one (toward `bias`, or toward
    /// the other end when they differ). Falls back to [`Selection::near`].
    pub fn between(anchor: &ResolvedPos, head: &ResolvedPos, bias: Option<i32>) -> Selection {
        let delta = pos_of(anchor) as i64 - pos_of(head) as i64;
        let bias = match bias {
            Some(bias) if bias != 0 && delta == 0 => bias,
            _ => {
                if delta >= 0 {
                    1
                } else {
                    -1
                }
            }
        };
        let mut head = head.clone();
        if !has_inline_content(&head) {
            let found = Selection::find_from(&head, bias, true)
                .or_else(|| Selection::find_from(&head, -bias, true));
            match found {
                Some(found) => head = found.resolved_head().clone(),
                None => return Selection::near(&head, bias),
            }
        }
        let mut anchor = anchor.clone();
        if !has_inline_content(&anchor) {
            if delta == 0 {
                anchor = head.clone();
            } else {
                let found = Selection::find_from(&anchor, -bias, true)
                    .or_else(|| Selection::find_from(&anchor, bias, true));
                anchor = match found {
                    Some(found) => found.resolved_anchor().clone(),
                    None => head.clone(),
                };
                if (pos_of(&anchor) < pos_of(&head)) != (delta < 0) {
                    anchor = head.clone();
                }
            }
        }
        Self::new(anchor, head).into()
    }

    /// The anchor.
    pub fn anchor(&self) -> &ResolvedPos {
        &self.anchor
    }

    /// The head.
    pub fn head(&self) -> &ResolvedPos {
        &self.head
    }

    /// Which side of its position the head's caret is on.
    pub fn affinity(&self) -> Affinity {
        self.affinity
    }

    /// The head, when the selection is a cursor (empty).
    pub fn cursor(&self) -> Option<&ResolvedPos> {
        (pos_of(&self.anchor) == pos_of(&self.head)).then_some(&self.head)
    }

    fn map(&self, doc: &Node, mapping: &dyn Mappable) -> Selection {
        let head = resolve(doc, mapping.map(pos_of(&self.head), 1));
        if !has_inline_content(&head) {
            return Selection::near(&head, 1);
        }
        let anchor = resolve(doc, mapping.map(pos_of(&self.anchor), 1));
        let anchor = if has_inline_content(&anchor) {
            anchor
        } else {
            head.clone()
        };
        Self::with_affinity(anchor, head, self.affinity).into()
    }
}

/// A selection of one node (one that [`NodeSelection::is_selectable`]
/// allows).
#[derive(Debug, Clone)]
pub struct NodeSelection {
    node: Node,
    ranges: Vec<SelectionRange>,
}

impl NodeSelection {
    /// Selects the node after `pos`.
    ///
    /// # Panics
    ///
    /// When no node starts at `pos`.
    pub fn new(pos: ResolvedPos) -> Self {
        let node = pos
            .node_after()
            .expect("a node after a node selection's position");
        let doc = pos.doc().clone();
        let to = resolve(&doc, pos_of(&pos) + node.node_size());
        Self {
            node,
            ranges: vec![SelectionRange::new(pos, to)],
        }
    }

    /// Selects the node starting at `from` in `doc`.
    pub fn create(doc: &Node, from: usize) -> Selection {
        Self::new(resolve(doc, from)).into()
    }

    /// Whether a node can be selected as a node: not text, and its type's
    /// spec does not turn it off.
    pub fn is_selectable(node: &Node) -> bool {
        !node.is_text() && node.ty().spec().selectable
    }

    /// The selected node.
    pub fn node(&self) -> &Node {
        &self.node
    }

    fn map(&self, doc: &Node, mapping: &dyn Mappable) -> Selection {
        let result = mapping.map_result(pos_of(&self.ranges[0].from), 1);
        let pos = resolve(doc, result.pos);
        if result.deleted {
            return Selection::near(&pos, 1);
        }
        match pos.node_after() {
            Some(node) if Self::is_selectable(&node) => Self::new(pos).into(),
            _ => Selection::near(&pos, 1),
        }
    }
}

/// A selection of the whole document.
#[derive(Debug, Clone)]
pub struct AllSelection {
    ranges: Vec<SelectionRange>,
}

impl AllSelection {
    /// Selects all of `doc`.
    pub fn new(doc: &Node) -> Self {
        let from = resolve(doc, 0);
        let to = resolve(doc, doc.content().size());
        Self {
            ranges: vec![SelectionRange::new(from, to)],
        }
    }
}

/// A selection kind the app defines (a table's cells, a gap cursor, ...).
/// [`Selection`] calls these where the built-in kinds have their own code.
pub trait CustomSelection: Send + Sync + fmt::Debug {
    /// The kind's name, the `type` of its JSON form.
    fn json_id(&self) -> &str;
    /// The anchor.
    fn anchor(&self) -> &ResolvedPos;
    /// The head.
    fn head(&self) -> &ResolvedPos;
    /// The ranges it covers (at least one).
    fn ranges(&self) -> &[SelectionRange];
    /// The selection after the change `mapping` describes, in `doc`.
    fn map(&self, doc: &Node, mapping: &dyn Mappable) -> Selection;
    /// Whether it equals `other`.
    fn eq(&self, other: &Selection) -> bool;
    /// Its JSON form, with `type` set to [`CustomSelection::json_id`].
    fn to_json(&self) -> Value;
    /// A bookmark of it.
    fn bookmark(&self) -> SelectionBookmark;
    /// What it covers as a slice; by default the first range's content.
    fn content(&self) -> Slice {
        let range = &self.ranges()[0];
        range
            .from
            .doc()
            .slice(pos_of(&range.from), pos_of(&range.to), true)
            .unwrap_or_else(|_| Slice::empty())
    }
    /// Whether the view draws it as a selection (the native one).
    fn visible(&self) -> bool {
        true
    }
}

/// A cursor between blocks where no textblock is (prosemirror-gapcursor's
/// `GapCursor`): before or after a block atom, between two of them, at
/// the start of the document before one. The view draws it as a
/// horizontal caret; typing there inserts the default textblock first.
/// Its JSON form is `{type: "gapcursor", pos}`.
#[derive(Debug, Clone)]
pub struct GapCursor {
    pos: ResolvedPos,
    ranges: Vec<SelectionRange>,
}

/// The JSON `type` of a [`GapCursor`].
pub const GAP_CURSOR: &str = "gapcursor";

impl GapCursor {
    /// A gap cursor at `pos` (which [`GapCursor::valid`] should allow).
    pub fn new(pos: ResolvedPos) -> Self {
        Self {
            ranges: vec![SelectionRange::new(pos.clone(), pos.clone())],
            pos,
        }
    }

    /// The gap cursor at `pos` as a selection.
    pub fn create(pos: ResolvedPos) -> Selection {
        Selection::custom(Arc::new(Self::new(pos)))
    }

    /// Where it is.
    pub fn pos(&self) -> &ResolvedPos {
        &self.pos
    }

    /// Whether a gap cursor can stand at `pos`: not in a textblock, with
    /// a closed block (an atom, an empty non-textblock, an isolating
    /// node, or the parent's edge) on both sides, in a parent whose
    /// default content there is a textblock (or whose spec's
    /// `extra.allowGapCursor` says so).
    pub fn valid(pos: &ResolvedPos) -> bool {
        let parent = pos.parent();
        if parent.is_textblock() || !closed_before(pos) || !closed_after(pos) {
            return false;
        }
        if let Some(allow) = parent
            .ty()
            .spec()
            .extra
            .get("allowGapCursor")
            .and_then(Value::as_bool)
        {
            return allow;
        }
        parent
            .content_match_at(pos.index(pos.depth))
            .and_then(|m| m.default_type())
            .is_some_and(|t| t.is_textblock())
    }

    /// The first valid gap cursor position from `pos` toward `dir`
    /// (`must_move`: not `pos` itself), as prosemirror-gapcursor's
    /// `findGapCursorFrom`.
    pub fn find_from(pos: &ResolvedPos, dir: i32, must_move: bool) -> Option<ResolvedPos> {
        let doc = pos.doc().clone();
        let mut at = pos.clone();
        let mut must_move = must_move;
        'search: loop {
            if !must_move && Self::valid(&at) {
                return Some(at);
            }
            let mut p = at.pos as i64;
            let mut next: Node;
            let mut d = at.depth;
            loop {
                let parent = at.node(d);
                if dir > 0 && at.index_after(d) < parent.child_count() {
                    next = parent.child(at.index_after(d)).clone();
                    break;
                } else if dir < 0 && at.index(d) > 0 {
                    next = parent.child(at.index(d) - 1).clone();
                    break;
                } else if d == 0 {
                    return None;
                }
                p += dir as i64;
                let cur = doc.resolve(p as usize).ok()?;
                if Self::valid(&cur) {
                    return Some(cur);
                }
                d -= 1;
            }
            loop {
                let inside = if dir > 0 {
                    next.first_child().cloned()
                } else {
                    next.last_child().cloned()
                };
                let Some(inside) = inside else {
                    if next.is_atom() && !next.is_text() && !NodeSelection::is_selectable(&next) {
                        let to = p + next.node_size() as i64 * dir as i64;
                        at = doc.resolve(to as usize).ok()?;
                        must_move = false;
                        continue 'search;
                    }
                    break;
                };
                next = inside;
                p += dir as i64;
                let cur = doc.resolve(p as usize).ok()?;
                if Self::valid(&cur) {
                    return Some(cur);
                }
            }
            return None;
        }
    }

    /// Reads its JSON form (`{type: "gapcursor", pos}`) in `doc`.
    pub fn from_json(doc: &Node, json: &Value) -> Option<Selection> {
        let pos = json.get("pos").and_then(Value::as_u64)? as usize;
        if pos > doc.content().size() {
            return None;
        }
        Some(Self::create(resolve(doc, pos)))
    }
}

// prosemirror-gapcursor's `closedBefore`.
fn closed_before(pos: &ResolvedPos) -> bool {
    for d in (0..=pos.depth).rev() {
        let index = pos.index(d);
        let parent = pos.node(d);
        if index == 0 {
            if parent.ty().spec().isolating {
                return true;
            }
            continue;
        }
        let mut before = parent.child(index - 1).clone();
        loop {
            if (before.child_count() == 0 && !before.inline_content())
                || before.is_atom()
                || before.ty().spec().isolating
            {
                return true;
            }
            if before.inline_content() {
                return false;
            }
            match before.last_child() {
                Some(last) => before = last.clone(),
                None => return true,
            }
        }
    }
    true
}

// prosemirror-gapcursor's `closedAfter`.
fn closed_after(pos: &ResolvedPos) -> bool {
    for d in (0..=pos.depth).rev() {
        let index = pos.index_after(d);
        let parent = pos.node(d);
        if index == parent.child_count() {
            if parent.ty().spec().isolating {
                return true;
            }
            continue;
        }
        let mut after = parent.child(index).clone();
        loop {
            if (after.child_count() == 0 && !after.inline_content())
                || after.is_atom()
                || after.ty().spec().isolating
            {
                return true;
            }
            if after.inline_content() {
                return false;
            }
            match after.first_child() {
                Some(first) => after = first.clone(),
                None => return true,
            }
        }
    }
    true
}

impl CustomSelection for GapCursor {
    fn json_id(&self) -> &str {
        GAP_CURSOR
    }

    fn anchor(&self) -> &ResolvedPos {
        &self.pos
    }

    fn head(&self) -> &ResolvedPos {
        &self.pos
    }

    fn ranges(&self) -> &[SelectionRange] {
        &self.ranges
    }

    fn map(&self, doc: &Node, mapping: &dyn Mappable) -> Selection {
        let pos = resolve(doc, mapping.map(pos_of(&self.pos), 1));
        if Self::valid(&pos) {
            Self::create(pos)
        } else {
            Selection::near(&pos, 1)
        }
    }

    fn eq(&self, other: &Selection) -> bool {
        other.is_gap_cursor() && other.head() == pos_of(&self.pos)
    }

    fn to_json(&self) -> Value {
        json!({"type": GAP_CURSOR, "pos": pos_of(&self.pos)})
    }

    fn bookmark(&self) -> SelectionBookmark {
        SelectionBookmark::Custom(Arc::new(GapBookmark(pos_of(&self.pos))))
    }

    fn content(&self) -> Slice {
        Slice::empty()
    }

    fn visible(&self) -> bool {
        false
    }
}

/// A [`GapCursor`]'s bookmark: its position.
#[derive(Debug)]
struct GapBookmark(usize);

impl CustomBookmark for GapBookmark {
    fn map(&self, mapping: &dyn Mappable) -> SelectionBookmark {
        SelectionBookmark::Custom(Arc::new(GapBookmark(mapping.map(self.0, 1))))
    }

    fn resolve(&self, doc: &Node) -> Selection {
        let pos = resolve(doc, self.0);
        if GapCursor::valid(&pos) {
            GapCursor::create(pos)
        } else {
            Selection::near(&pos, 1)
        }
    }
}

/// The kind of a [`Selection`].
#[derive(Debug, Clone)]
pub enum SelectionKind {
    /// A range of text, or a cursor.
    Text(TextSelection),
    /// One node.
    Node(NodeSelection),
    /// The whole document.
    All(AllSelection),
    /// A kind the app defines.
    Custom(Arc<dyn CustomSelection>),
}

/// A selection in a document: its ranges, its anchor and head, and what it
/// is ([`SelectionKind`]).
#[derive(Debug, Clone)]
pub struct Selection {
    kind: SelectionKind,
}

impl From<TextSelection> for Selection {
    fn from(selection: TextSelection) -> Self {
        Self {
            kind: SelectionKind::Text(selection),
        }
    }
}

impl From<NodeSelection> for Selection {
    fn from(selection: NodeSelection) -> Self {
        Self {
            kind: SelectionKind::Node(selection),
        }
    }
}

impl From<AllSelection> for Selection {
    fn from(selection: AllSelection) -> Self {
        Self {
            kind: SelectionKind::All(selection),
        }
    }
}

impl Selection {
    /// An app-defined selection.
    pub fn custom(selection: Arc<dyn CustomSelection>) -> Self {
        Self {
            kind: SelectionKind::Custom(selection),
        }
    }

    /// What it is.
    pub fn kind(&self) -> &SelectionKind {
        &self.kind
    }

    /// It as a text selection.
    pub fn as_text(&self) -> Option<&TextSelection> {
        match &self.kind {
            SelectionKind::Text(selection) => Some(selection),
            _ => None,
        }
    }

    /// It as a node selection.
    pub fn as_node(&self) -> Option<&NodeSelection> {
        match &self.kind {
            SelectionKind::Node(selection) => Some(selection),
            _ => None,
        }
    }

    /// Whether it is a [`GapCursor`].
    pub fn is_gap_cursor(&self) -> bool {
        matches!(&self.kind, SelectionKind::Custom(s) if s.json_id() == GAP_CURSOR)
    }

    /// Whether it selects the whole document as such.
    pub fn is_all(&self) -> bool {
        matches!(self.kind, SelectionKind::All(_))
    }

    /// The ranges it covers.
    pub fn ranges(&self) -> &[SelectionRange] {
        match &self.kind {
            SelectionKind::Text(selection) => &selection.ranges,
            SelectionKind::Node(selection) => &selection.ranges,
            SelectionKind::All(selection) => &selection.ranges,
            SelectionKind::Custom(selection) => selection.ranges(),
        }
    }

    /// The resolved anchor (the end that stays when the selection is
    /// extended).
    pub fn resolved_anchor(&self) -> &ResolvedPos {
        match &self.kind {
            SelectionKind::Text(selection) => &selection.anchor,
            SelectionKind::Custom(selection) => selection.anchor(),
            _ => &self.ranges()[0].from,
        }
    }

    /// The resolved head (the end that moves).
    pub fn resolved_head(&self) -> &ResolvedPos {
        match &self.kind {
            SelectionKind::Text(selection) => &selection.head,
            SelectionKind::Custom(selection) => selection.head(),
            _ => &self.ranges()[0].to,
        }
    }

    /// The resolved start of the first range.
    pub fn resolved_from(&self) -> &ResolvedPos {
        &self.ranges()[0].from
    }

    /// The resolved end of the first range.
    pub fn resolved_to(&self) -> &ResolvedPos {
        &self.ranges()[0].to
    }

    /// The anchor's position.
    pub fn anchor(&self) -> usize {
        pos_of(self.resolved_anchor())
    }

    /// The head's position.
    pub fn head(&self) -> usize {
        pos_of(self.resolved_head())
    }

    /// The start of the first range.
    pub fn from(&self) -> usize {
        pos_of(self.resolved_from())
    }

    /// The end of the first range.
    pub fn to(&self) -> usize {
        pos_of(self.resolved_to())
    }

    /// Whether every range is empty.
    pub fn empty(&self) -> bool {
        self.ranges()
            .iter()
            .all(|range| pos_of(&range.from) == pos_of(&range.to))
    }

    /// The head of an empty text selection.
    pub fn cursor(&self) -> Option<&ResolvedPos> {
        self.as_text().and_then(TextSelection::cursor)
    }

    /// The head's [`Affinity`] (downstream for kinds other than text).
    pub fn affinity(&self) -> Affinity {
        self.as_text()
            .map_or(Affinity::Downstream, TextSelection::affinity)
    }

    /// Whether the view draws it as a selection.
    pub fn visible(&self) -> bool {
        match &self.kind {
            SelectionKind::Custom(selection) => selection.visible(),
            _ => true,
        }
    }

    /// The selection after the change `mapping` describes, in `doc` (the
    /// changed document).
    pub fn map(&self, doc: &Node, mapping: &dyn Mappable) -> Selection {
        match &self.kind {
            SelectionKind::Text(selection) => selection.map(doc, mapping),
            SelectionKind::Node(selection) => selection.map(doc, mapping),
            SelectionKind::All(_) => AllSelection::new(doc).into(),
            SelectionKind::Custom(selection) => selection.map(doc, mapping),
        }
    }

    /// What it covers, as a slice of the document.
    pub fn content(&self) -> Slice {
        match &self.kind {
            SelectionKind::Custom(selection) => selection.content(),
            _ => self
                .resolved_from()
                .doc()
                .slice(self.from(), self.to(), true)
                .unwrap_or_else(|_| Slice::empty()),
        }
    }

    /// Replaces what it covers with `content` in `tr` (the other ranges
    /// with nothing) and puts the selection after the inserted content.
    pub fn replace(&self, tr: &mut Transaction, content: Slice) {
        // Where the cursor goes after the insertion: into inline content
        // when the slice ends in it, else into the next block.
        let mut last_node = content.content.last_child().cloned();
        let mut last_parent = None;
        for _ in 0..content.open_end {
            let next = last_node
                .as_ref()
                .and_then(|node| node.last_child().cloned());
            last_parent = last_node;
            last_node = next;
        }
        let bias = match (&last_node, &last_parent) {
            (Some(node), _) if node.is_inline() => -1,
            (None, Some(parent)) if parent.is_textblock() => -1,
            _ => 1,
        };
        let map_from = tr.steps.len();
        let mut content = Some(content);
        for (i, range) in self.ranges().iter().enumerate() {
            let mapping = tr.mapping.slice(map_from, tr.mapping.maps.len());
            let from = mapping.map(pos_of(&range.from), 1);
            let to = mapping.map(pos_of(&range.to), 1);
            let slice = content.take().unwrap_or_else(Slice::empty);
            let _ = tr.replace_range(from, to, slice);
            if i == 0 {
                selection_to_insertion_end(tr, map_from, bias);
            }
        }
    }

    /// Replaces what it covers with `node` in `tr` (the other ranges with
    /// nothing) and puts the selection after it.
    pub fn replace_with(&self, tr: &mut Transaction, node: Node) {
        let map_from = tr.steps.len();
        let bias = if node.is_inline() { -1 } else { 1 };
        let mut node = Some(node);
        for (i, range) in self.ranges().iter().enumerate() {
            let mapping = tr.mapping.slice(map_from, tr.mapping.maps.len());
            let from = mapping.map(pos_of(&range.from), 1);
            let to = mapping.map(pos_of(&range.to), 1);
            match node.take() {
                Some(node) if i == 0 => {
                    let _ = tr.replace_range_with(from, to, node);
                    selection_to_insertion_end(tr, map_from, bias);
                }
                _ => {
                    let _ = tr.delete_range(from, to);
                }
            }
        }
    }

    /// Its JSON form, as ProseMirror writes it (`{type: "text", anchor,
    /// head}`, `{type: "node", anchor}`, `{type: "all"}`), with `affinity`
    /// when upstream.
    pub fn to_json(&self) -> Value {
        match &self.kind {
            SelectionKind::Text(selection) => {
                let mut value =
                    json!({"type": "text", "anchor": self.anchor(), "head": self.head()});
                if selection.affinity == Affinity::Upstream {
                    value["affinity"] = selection.affinity.to_json();
                }
                value
            }
            SelectionKind::Node(_) => json!({"type": "node", "anchor": self.anchor()}),
            SelectionKind::All(_) => json!({"type": "all"}),
            SelectionKind::Custom(selection) => selection.to_json(),
        }
    }

    /// Reads a built-in kind's JSON form in `doc`.
    pub fn from_json(doc: &Node, json: &Value) -> Result<Selection, StateError> {
        Self::from_json_with(doc, json, &|_, _, _| None)
    }

    /// Reads a JSON form in `doc`, asking `custom` (with the `type`, the
    /// document and the JSON) for kinds other than the built-in ones.
    pub fn from_json_with(
        doc: &Node,
        json: &Value,
        custom: &dyn Fn(&str, &Node, &Value) -> Option<Selection>,
    ) -> Result<Selection, StateError> {
        let ty = json
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| StateError::Json("a selection without a type".into()))?;
        let size = doc.content().size();
        let pos = |key: &str| -> Result<usize, StateError> {
            json.get(key)
                .and_then(Value::as_u64)
                .map(|pos| pos as usize)
                .filter(|pos| *pos <= size)
                .ok_or_else(|| StateError::Json(format!("a selection's `{key}` out of range")))
        };
        match ty {
            "text" => {
                let anchor = resolve(doc, pos("anchor")?);
                let head = resolve(doc, pos("head")?);
                let affinity = Affinity::from_json(json.get("affinity"));
                Ok(TextSelection::with_affinity(anchor, head, affinity).into())
            }
            "node" => {
                let anchor = resolve(doc, pos("anchor")?);
                if anchor.node_after().is_none() {
                    return Err(StateError::Json("a node selection without a node".into()));
                }
                Ok(NodeSelection::new(anchor).into())
            }
            "all" => Ok(AllSelection::new(doc).into()),
            GAP_CURSOR => GapCursor::from_json(doc, json)
                .ok_or_else(|| StateError::Json("a gap cursor's `pos` out of range".into())),
            other => custom(other, doc, json)
                .ok_or_else(|| StateError::Json(format!("unknown selection type `{other}`"))),
        }
    }

    /// Its kind's name, the `type` of its JSON form.
    pub fn json_id(&self) -> &str {
        match &self.kind {
            SelectionKind::Text(_) => "text",
            SelectionKind::Node(_) => "node",
            SelectionKind::All(_) => "all",
            SelectionKind::Custom(selection) => selection.json_id(),
        }
    }

    /// A bookmark of it: what history keeps instead of the selection.
    pub fn get_bookmark(&self) -> SelectionBookmark {
        match &self.kind {
            SelectionKind::Text(selection) => SelectionBookmark::Text {
                anchor: self.anchor(),
                head: self.head(),
                affinity: selection.affinity,
            },
            SelectionKind::Node(_) => SelectionBookmark::Node { pos: self.anchor() },
            SelectionKind::All(_) => SelectionBookmark::All,
            SelectionKind::Custom(selection) => selection.bookmark(),
        }
    }

    /// A valid selection near `pos`: a cursor or a selected node, searching
    /// toward `bias` first, the whole document when there is neither.
    pub fn near(pos: &ResolvedPos, bias: i32) -> Selection {
        Self::find_from(pos, bias, false)
            .or_else(|| Self::find_from(pos, -bias, false))
            .unwrap_or_else(|| AllSelection::new(&pos.doc().clone()).into())
    }

    /// The first valid cursor or (unless `text_only`) selectable node from
    /// `pos` in direction `dir` (negative is backward).
    pub fn find_from(pos: &ResolvedPos, dir: i32, text_only: bool) -> Option<Selection> {
        if has_inline_content(pos) {
            return Some(TextSelection::new(pos.clone(), pos.clone()).into());
        }
        let doc = pos.doc().clone();
        let parent = pos.parent().clone();
        if let Some(found) = find_selection_in(
            &doc,
            &parent,
            pos_of(pos),
            pos.index(depth_of(pos)),
            dir,
            text_only,
        ) {
            return Some(found);
        }
        for depth in (0..depth_of(pos)).rev() {
            let node = pos.node(depth).clone();
            let found = if dir < 0 {
                find_selection_in(
                    &doc,
                    &node,
                    pos.before(depth + 1),
                    pos.index(depth),
                    dir,
                    text_only,
                )
            } else {
                find_selection_in(
                    &doc,
                    &node,
                    pos.after(depth + 1),
                    pos.index(depth) + 1,
                    dir,
                    text_only,
                )
            };
            if found.is_some() {
                return found;
            }
        }
        None
    }

    /// The first valid selection in `doc`.
    pub fn at_start(doc: &Node) -> Selection {
        find_selection_in(doc, doc, 0, 0, 1, false).unwrap_or_else(|| AllSelection::new(doc).into())
    }

    /// The last valid selection in `doc`.
    pub fn at_end(doc: &Node) -> Selection {
        find_selection_in(doc, doc, doc.content().size(), doc.child_count(), -1, false)
            .unwrap_or_else(|| AllSelection::new(doc).into())
    }
}

// ProseMirror's `findSelectionIn`: the first cursor or selectable node in
// `node` (whose content starts at `pos`) from child `index` toward `dir`.
fn find_selection_in(
    doc: &Node,
    node: &Node,
    pos: usize,
    index: usize,
    dir: i32,
    text_only: bool,
) -> Option<Selection> {
    if node.ty().is_textblock() {
        return Some(TextSelection::create(doc, pos, None));
    }
    let mut pos = pos as i64;
    let mut i = index as i64 - if dir > 0 { 0 } else { 1 };
    while if dir > 0 {
        i < node.child_count() as i64
    } else {
        i >= 0
    } {
        let child = node.child(i as usize).clone();
        let size = child.node_size() as i64;
        if !child.is_atom() {
            let start = if dir < 0 { child.child_count() } else { 0 };
            let inner = find_selection_in(
                doc,
                &child,
                (pos + dir as i64) as usize,
                start,
                dir,
                text_only,
            );
            if inner.is_some() {
                return inner;
            }
        } else if !text_only && NodeSelection::is_selectable(&child) {
            let at = pos - if dir < 0 { size } else { 0 };
            return Some(NodeSelection::create(doc, at as usize));
        }
        pos += size * dir as i64;
        i += dir as i64;
    }
    None
}

// Puts the selection at the end of what the last replace step (after
// `start_len`) inserted.
fn selection_to_insertion_end(tr: &mut Transaction, start_len: usize, bias: i32) {
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
    tr.mapping.maps[last].for_each(|_from, _to, _new_from, new_to| {
        if end.is_none() {
            end = Some(new_to);
        }
    });
    if let Some(end) = end {
        let pos = resolve(tr.doc(), end);
        tr.set_selection(Selection::near(&pos, bias));
    }
}

/// Reads a custom selection kind's JSON form in a document.
pub type SelectionFromJson = Arc<dyn Fn(&Node, &Value) -> Option<Selection> + Send + Sync>;

/// The custom selection kinds an editor reads from JSON, by
/// [`Selection::json_id`] (ProseMirror's `Selection.jsonID`, kept per
/// editor rather than globally).
#[derive(Clone, Default)]
pub struct SelectionRegistry {
    kinds: std::collections::BTreeMap<String, SelectionFromJson>,
}

impl fmt::Debug for SelectionRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_set().entries(self.kinds.keys()).finish()
    }
}

impl SelectionRegistry {
    /// Registers the kind `id`; fails if a kind (built-in or registered)
    /// has that name.
    pub fn register(&mut self, id: &str, from_json: SelectionFromJson) -> Result<(), StateError> {
        if matches!(id, "text" | "node" | "all" | GAP_CURSOR) || self.kinds.contains_key(id) {
            return Err(StateError::Json(format!(
                "selection type `{id}` registered twice"
            )));
        }
        self.kinds.insert(id.to_owned(), from_json);
        Ok(())
    }

    /// Reads a selection's JSON form in `doc`, built-in or registered.
    pub fn from_json(&self, doc: &Node, json: &Value) -> Result<Selection, StateError> {
        Selection::from_json_with(doc, json, &|id, doc, json| {
            self.kinds.get(id).and_then(|read| read(doc, json))
        })
    }
}

/// A selection that a custom kind keeps without a document.
pub trait CustomBookmark: Send + Sync + fmt::Debug {
    /// The bookmark after the change `mapping` describes.
    fn map(&self, mapping: &dyn Mappable) -> SelectionBookmark;
    /// The selection in `doc`.
    fn resolve(&self, doc: &Node) -> Selection;
}

/// A selection without its document: positions that map through changes
/// and resolve into a selection again (history keeps these).
#[derive(Debug, Clone)]
pub enum SelectionBookmark {
    /// A text selection's positions.
    Text {
        /// The anchor.
        anchor: usize,
        /// The head.
        head: usize,
        /// The head's affinity.
        affinity: Affinity,
    },
    /// A node selection's position.
    Node {
        /// Where the node starts.
        pos: usize,
    },
    /// The whole document.
    All,
    /// A custom kind's bookmark.
    Custom(Arc<dyn CustomBookmark>),
}

impl SelectionBookmark {
    /// The bookmark after the change `mapping` describes.
    pub fn map(&self, mapping: &dyn Mappable) -> SelectionBookmark {
        match self {
            Self::Text {
                anchor,
                head,
                affinity,
            } => Self::Text {
                anchor: mapping.map(*anchor, 1),
                head: mapping.map(*head, 1),
                affinity: *affinity,
            },
            Self::Node { pos } => {
                let result = mapping.map_result(*pos, 1);
                if result.deleted {
                    Self::Text {
                        anchor: result.pos,
                        head: result.pos,
                        affinity: Affinity::Downstream,
                    }
                } else {
                    Self::Node { pos: result.pos }
                }
            }
            Self::All => Self::All,
            Self::Custom(bookmark) => bookmark.map(mapping),
        }
    }

    /// The selection in `doc`.
    pub fn resolve(&self, doc: &Node) -> Selection {
        match self {
            Self::Text {
                anchor,
                head,
                affinity,
            } => {
                let anchor = resolve(doc, *anchor);
                let head = resolve(doc, *head);
                let selection = TextSelection::between(&anchor, &head, None);
                match selection.kind {
                    SelectionKind::Text(text) if *affinity != Affinity::Downstream => {
                        TextSelection::with_affinity(text.anchor, text.head, *affinity).into()
                    }
                    _ => selection,
                }
            }
            Self::Node { pos } => {
                let at = resolve(doc, *pos);
                match at.node_after() {
                    Some(node) if NodeSelection::is_selectable(&node) => {
                        NodeSelection::new(at).into()
                    }
                    _ => Selection::near(&at, 1),
                }
            }
            Self::All => AllSelection::new(doc).into(),
            Self::Custom(bookmark) => bookmark.resolve(doc),
        }
    }
}

/// The same selection: the same kind over the same positions (and, for a
/// text selection, the same affinity).
impl PartialEq for Selection {
    fn eq(&self, other: &Selection) -> bool {
        match (&self.kind, &other.kind) {
            (SelectionKind::Text(a), SelectionKind::Text(b)) => {
                pos_of(&a.anchor) == pos_of(&b.anchor)
                    && pos_of(&a.head) == pos_of(&b.head)
                    && a.affinity == b.affinity
            }
            (SelectionKind::Node(_), SelectionKind::Node(_))
            | (SelectionKind::All(_), SelectionKind::All(_)) => {
                self.from() == other.from() && self.to() == other.to()
            }
            (SelectionKind::Custom(a), _) => a.eq(other),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::rich_editor::state::test_util::*;

    #[test]
    fn text_selection_maps_through_an_insertion() {
        let s = schema();
        let state = state(&s, doc(&s, vec![p(&s, "hello")]), vec![]);
        let mut tr = state.tr();
        tr.set_selection(TextSelection::create(tr.doc(), 2, Some(4)));
        tr.insert(
            1,
            crate::rich_editor::model::Fragment::from(vec![s.text("ab", vec![])]),
        )
        .unwrap();
        let selection = tr.selection();
        assert_eq!((selection.anchor(), selection.head()), (4, 6));
        // Typing over a range collapses the selection to its end, as
        // ProseMirror's insertText does.
        tr.insert_text("x", Some(1), None);
        assert!(tr.selection().empty());
    }

    #[test]
    fn affinity_is_kept_through_mapping_and_json() {
        let s = schema();
        let d = doc(&s, vec![p(&s, "hello")]);
        let anchor = d.resolve(3).unwrap();
        let selection: Selection =
            TextSelection::with_affinity(anchor.clone(), anchor, Affinity::Upstream).into();
        let json = selection.to_json();
        assert_eq!(
            json,
            json!({"type": "text", "anchor": 3, "head": 3, "affinity": "upstream"})
        );
        let back = Selection::from_json(&d, &json).unwrap();
        assert!(back.eq(&selection));
        let mapped = selection.map(&d, &crate::rich_editor::transform::StepMap::empty());
        assert_eq!(mapped.affinity(), Affinity::Upstream);
    }

    #[test]
    fn node_selection_falls_back_near_when_deleted() {
        let s = schema();
        let hr = node(&s, "horizontal_rule", vec![]);
        let state = state(&s, doc(&s, vec![p(&s, "a"), hr, p(&s, "b")]), vec![]);
        let mut tr = state.tr();
        tr.set_selection(NodeSelection::create(tr.doc(), 3));
        assert_eq!(
            tr.selection().as_node().unwrap().node().ty().name(),
            "horizontal_rule"
        );
        let _ = tr.delete(3, 4);
        let selection = tr.selection();
        assert!(selection.as_text().is_some());
        assert_eq!(selection.head(), 4);
    }

    #[test]
    fn at_start_finds_a_node_or_a_cursor() {
        let s = schema();
        let d = doc(&s, vec![node(&s, "horizontal_rule", vec![]), p(&s, "x")]);
        assert!(Selection::at_start(&d).as_node().is_some());
        let end = Selection::at_end(&d);
        assert_eq!(end.cursor().map(|pos| pos.pos), Some(3));
        let near = Selection::near(&d.resolve(1).unwrap(), 1);
        assert_eq!(near.head(), 2);
    }

    #[test]
    fn bookmarks_map_and_resolve() {
        let s = schema();
        let d = doc(&s, vec![p(&s, "hello")]);
        let bookmark = TextSelection::create(&d, 2, Some(4)).get_bookmark();
        let map = crate::rich_editor::transform::StepMap::offset(0);
        let selection = bookmark.map(&map).resolve(&d);
        assert_eq!((selection.anchor(), selection.head()), (2, 4));
        let all = AllSelection::new(&d);
        assert_eq!(
            <Selection as From<AllSelection>>::from(all).to_json(),
            json!({"type": "all"})
        );
    }

    /// `hr`, `hr`, `p("x")`: gaps at 0 (before the first rule) and 1
    /// (between the rules), none at 2 (a textblock follows).
    fn rules() -> Node {
        let s = schema();
        doc(
            &s,
            vec![
                node(&s, "horizontal_rule", vec![]),
                node(&s, "horizontal_rule", vec![]),
                p(&s, "x"),
            ],
        )
    }

    #[test]
    fn gap_cursors_stand_only_between_closed_blocks() {
        let d = rules();
        assert!(GapCursor::valid(&d.resolve(0).unwrap()));
        assert!(GapCursor::valid(&d.resolve(1).unwrap()));
        assert!(!GapCursor::valid(&d.resolve(2).unwrap()));
        // Inside a textblock never.
        assert!(!GapCursor::valid(&d.resolve(3).unwrap()));
        // After a final atom, at the document's end.
        let s = schema();
        let end = doc(&s, vec![p(&s, "x"), node(&s, "horizontal_rule", vec![])]);
        assert!(GapCursor::valid(&end.resolve(4).unwrap()));
        assert!(!GapCursor::valid(&end.resolve(3).unwrap()));
    }

    #[test]
    fn gap_cursors_are_found_both_ways() {
        let d = rules();
        // Forward from the start (not moving): the start itself.
        let at = GapCursor::find_from(&d.resolve(0).unwrap(), 1, false).unwrap();
        assert_eq!(at.pos, 0);
        // Forward moving from 0: past the first rule, at 1.
        let at = GapCursor::find_from(&d.resolve(0).unwrap(), 1, true);
        assert_eq!(at.map(|p| p.pos), None, "a selectable rule comes first");
        // Backward from the paragraph's front edge: the rule is selectable,
        // so no gap comes before it.
        assert!(GapCursor::find_from(&d.resolve(2).unwrap(), -1, false).is_none());
        // From 1 not moving: itself.
        let at = GapCursor::find_from(&d.resolve(1).unwrap(), -1, false).unwrap();
        assert_eq!(at.pos, 1);
        // Into the nothing past the document's end.
        let s = schema();
        let end = doc(&s, vec![p(&s, "x"), node(&s, "horizontal_rule", vec![])]);
        let at = GapCursor::find_from(&end.resolve(4).unwrap(), 1, true);
        assert!(at.is_none());
        // Backward from the end: the gap after the rule is the end itself.
        let at = GapCursor::find_from(&end.resolve(4).unwrap(), -1, false).unwrap();
        assert_eq!(at.pos, 4);
    }

    #[test]
    fn gap_cursors_round_trip_json_map_and_bookmark() {
        let d = rules();
        let gap = GapCursor::create(d.resolve(1).unwrap());
        assert!(gap.is_gap_cursor());
        assert!(!gap.visible());
        assert!(gap.content().content.size() == 0);
        let json = gap.to_json();
        assert_eq!(json, json!({"type": "gapcursor", "pos": 1}));
        let back = Selection::from_json(&d, &json).unwrap();
        assert!(back.is_gap_cursor() && back.head() == 1);
        assert!(gap == back);
        // Mapping through an insertion before it moves it.
        let map = crate::rich_editor::transform::StepMap::offset(0);
        let mapped = gap.map(&d, &map);
        assert!(mapped.is_gap_cursor() && mapped.head() == 1);
        let again = gap.get_bookmark().map(&map).resolve(&d);
        assert!(again.is_gap_cursor() && again.head() == 1);
        // Where no gap can stand, it falls back to a near selection.
        let s = schema();
        let plain = doc(&s, vec![p(&s, "ab")]);
        let fallback = gap.get_bookmark().resolve(&plain);
        assert!(!fallback.is_gap_cursor());
        // A registered kind cannot take the name.
        let mut registry = SelectionRegistry::default();
        assert!(
            registry
                .register(GAP_CURSOR, Arc::new(|_, _| None))
                .is_err()
        );
    }
}
