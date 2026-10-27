//! Decorations: how a plugin asks the view to draw a range (attributes on
//! inline content or on a node) or a widget at a position, without
//! changing the document. They map through changes as the selection does.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::rich_editor::{model::Node, transform::Mappable};

/// What a [`Decoration`] draws.
#[derive(Debug, Clone, PartialEq)]
pub enum DecorationKind {
    /// Attributes (classes, styles) on the inline content of the range.
    Inline {
        /// The attributes.
        attrs: BTreeMap<String, Value>,
        /// Whether content inserted at the start joins the range.
        inclusive_start: bool,
        /// Whether content inserted at the end joins the range.
        inclusive_end: bool,
    },
    /// A widget the view makes for `key` at `from` (`to` equals `from`).
    Widget {
        /// What the view makes the widget from.
        key: String,
        /// Which side of the position it sticks to: negative before
        /// content inserted there, otherwise after.
        side: i32,
    },
    /// Attributes on the node that spans exactly the range.
    Node {
        /// The attributes.
        attrs: BTreeMap<String, Value>,
    },
}

/// One decoration over `from..to`.
#[derive(Debug, Clone, PartialEq)]
pub struct Decoration {
    /// The start.
    pub from: usize,
    /// The end.
    pub to: usize,
    /// What it draws.
    pub kind: DecorationKind,
    /// Free-form data for plugins (ProseMirror's `spec`): what they find
    /// decorations by.
    pub spec: BTreeMap<String, Value>,
}

impl Decoration {
    /// Attributes on the inline content of `from..to`.
    pub fn inline(from: usize, to: usize, attrs: BTreeMap<String, Value>) -> Self {
        Self {
            from,
            to,
            kind: DecorationKind::Inline {
                attrs,
                inclusive_start: false,
                inclusive_end: false,
            },
            spec: BTreeMap::new(),
        }
    }

    /// A widget at `pos`.
    pub fn widget(pos: usize, key: &str, side: i32) -> Self {
        Self {
            from: pos,
            to: pos,
            kind: DecorationKind::Widget {
                key: key.to_owned(),
                side,
            },
            spec: BTreeMap::new(),
        }
    }

    /// Attributes on the node at `from..to`.
    pub fn node(from: usize, to: usize, attrs: BTreeMap<String, Value>) -> Self {
        Self {
            from,
            to,
            kind: DecorationKind::Node { attrs },
            spec: BTreeMap::new(),
        }
    }

    /// The same with `spec`.
    pub fn with_spec(mut self, spec: BTreeMap<String, Value>) -> Self {
        self.spec = spec;
        self
    }

    /// Whether content inserted at its edges joins it (inline ones).
    pub fn inclusive(mut self, start: bool, end: bool) -> Self {
        if let DecorationKind::Inline {
            inclusive_start,
            inclusive_end,
            ..
        } = &mut self.kind
        {
            *inclusive_start = start;
            *inclusive_end = end;
        }
        self
    }

    /// It after the change `mapping` describes; `None` when the change
    /// removed what it decorates.
    pub fn map(&self, mapping: &dyn Mappable) -> Option<Decoration> {
        match &self.kind {
            DecorationKind::Inline {
                inclusive_start,
                inclusive_end,
                ..
            } => {
                let from = mapping.map(self.from, if *inclusive_start { -1 } else { 1 });
                let to = mapping.map(self.to, if *inclusive_end { 1 } else { -1 });
                (from < to).then(|| Decoration {
                    from,
                    to,
                    kind: self.kind.clone(),
                    spec: self.spec.clone(),
                })
            }
            DecorationKind::Widget { side, .. } => {
                let result = mapping.map_result(self.from, if *side < 0 { -1 } else { 1 });
                (!result.deleted).then(|| Decoration {
                    from: result.pos,
                    to: result.pos,
                    kind: self.kind.clone(),
                    spec: self.spec.clone(),
                })
            }
            DecorationKind::Node { .. } => {
                let from = mapping.map_result(self.from, 1);
                let to = mapping.map_result(self.to, -1);
                (!from.deleted && !to.deleted && from.pos < to.pos).then(|| Decoration {
                    from: from.pos,
                    to: to.pos,
                    kind: self.kind.clone(),
                    spec: self.spec.clone(),
                })
            }
        }
    }
}

/// A plugin's decorations, sorted by start and end.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DecorationSet {
    decorations: Vec<Decoration>,
}

impl DecorationSet {
    /// No decorations.
    pub fn empty() -> Self {
        Self::default()
    }

    /// A set of `decorations` over `doc` (dropping those outside it).
    pub fn create(doc: &Node, decorations: Vec<Decoration>) -> Self {
        let size = doc.content().size();
        let mut decorations: Vec<_> = decorations
            .into_iter()
            .filter(|decoration| decoration.to <= size)
            .collect();
        sort(&mut decorations);
        Self { decorations }
    }

    /// Whether it has none.
    pub fn is_empty(&self) -> bool {
        self.decorations.is_empty()
    }

    /// Its decorations, in order.
    pub fn iter(&self) -> impl Iterator<Item = &Decoration> {
        self.decorations.iter()
    }

    /// The decorations touching `from..=to` (all when both are `None`).
    pub fn find(&self, from: Option<usize>, to: Option<usize>) -> Vec<&Decoration> {
        let from = from.unwrap_or(0);
        let to = to.unwrap_or(usize::MAX);
        self.decorations
            .iter()
            .take_while(|decoration| decoration.from <= to)
            .filter(|decoration| decoration.to >= from)
            .collect()
    }

    /// The decorations touching `from..=to` whose spec passes `predicate`.
    pub fn find_by(
        &self,
        from: Option<usize>,
        to: Option<usize>,
        predicate: impl Fn(&BTreeMap<String, Value>) -> bool,
    ) -> Vec<&Decoration> {
        self.find(from, to)
            .into_iter()
            .filter(|decoration| predicate(&decoration.spec))
            .collect()
    }

    /// The set after the change `mapping` describes, over `doc` (the
    /// changed document).
    pub fn map(&self, mapping: &dyn Mappable, doc: &Node) -> Self {
        let size = doc.content().size();
        let mut decorations: Vec<_> = self
            .decorations
            .iter()
            .filter_map(|decoration| decoration.map(mapping))
            .filter(|decoration| decoration.to <= size)
            .collect();
        sort(&mut decorations);
        Self { decorations }
    }

    /// The set with `decorations` added.
    pub fn add(&self, decorations: Vec<Decoration>) -> Self {
        let mut all = self.decorations.clone();
        all.extend(decorations);
        sort(&mut all);
        Self { decorations: all }
    }

    /// The set without `decorations`.
    pub fn remove(&self, decorations: &[Decoration]) -> Self {
        Self {
            decorations: self
                .decorations
                .iter()
                .filter(|decoration| !decorations.contains(decoration))
                .cloned()
                .collect(),
        }
    }
}

fn sort(decorations: &mut [Decoration]) {
    decorations.sort_by_key(|decoration| (decoration.from, decoration.to));
}
