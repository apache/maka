//! Elements that name other elements for assistive technologies
//! (`accessibilityActiveDescendant`, `accessibilityControls`,
//! `accessibilityDescribedBy`): a combo box's field names its highlighted
//! option and its listbox, a list that keeps the keyboard focus names its
//! cursor row, a field names its error line.
//!
//! The app names an element (a JS ref, or a Rust `ElementRef`), and the
//! platforms get the native view's id in the view's accessibility
//! ([`crate::Accessibility::active_descendant`],
//! [`crate::Accessibility::controls`],
//! [`crate::Accessibility::described_by`]). What is named is looked up
//! again before each round's views go out, so it may be rendered after the
//! view naming it (a virtualized list's row, made as the list lays out), go
//! away (scrolled out of a list: the relation names nothing then) or be
//! carried by another element (a ref moved to the row the cursor reached),
//! and the view's props go out again only when what the platform reads
//! changed.
//!
//! The element describing a view gives it its text as well, in
//! [`crate::Accessibility::description`], so every platform reads it after
//! the name, whether its accessibility has such a relation or not: the
//! labels and texts inside the element, in order, the hidden ones left
//! out. The view's own `accessibilityDescription` is kept apart while it
//! is described, and is its description again once the element named is
//! gone or has no text (ARIA's `aria-describedby` wins over
//! `aria-description` alike).
//!
//! Nothing runs while no view names another: the pass returns at once on
//! an empty `relators`.

use std::sync::Arc;

use super::{Core, Key, Kind, dirty};
use crate::{NodeId, element::ElementTarget, text::TextEngine};

/// What one view names.
#[derive(Debug)]
pub(super) struct Relator {
    key: Key,
    /// Its `accessibilityActiveDescendant`.
    active_descendant: Option<ElementTarget>,
    /// Its `accessibilityControls`.
    controls: Option<ElementTarget>,
    /// Its `accessibilityDescribedBy`.
    described_by: Option<ElementTarget>,
    /// Its own `accessibilityDescription`, while `described_by` is set.
    own_description: Option<Arc<str>>,
}

impl Relator {
    fn is_empty(&self) -> bool {
        self.active_descendant.is_none() && self.controls.is_none() && self.described_by.is_none()
    }
}

/// Which relation a prop sets.
#[derive(Debug, Clone, Copy)]
pub(super) enum Relation {
    ActiveDescendant,
    Controls,
    DescribedBy,
}

/// What a view's relations give its accessibility now.
#[derive(Debug, Default, PartialEq)]
struct Resolved {
    active_descendant: Option<NodeId>,
    controls: Option<NodeId>,
    described_by: Option<NodeId>,
    /// Its description, while it names an element describing it.
    description: Option<Option<Arc<str>>>,
}

impl<M: TextEngine> Core<M> {
    /// View `key` names `target` (or nothing) by `relation`.
    pub(super) fn set_relation(
        &mut self,
        key: Key,
        relation: Relation,
        target: Option<ElementTarget>,
    ) {
        let own = self.nodes[key as usize]
            .props
            .as_ref()
            .and_then(|p| p.accessibility.description.clone());
        let at = self.relators.iter().position(|r| r.key == key);
        let relator = match at {
            Some(i) => &mut self.relators[i],
            None if target.is_none() => return,
            None => {
                self.relators.push(Relator {
                    key,
                    active_descendant: None,
                    controls: None,
                    described_by: None,
                    own_description: None,
                });
                self.relators.last_mut().unwrap()
            }
        };
        let mut restore = None;
        match relation {
            Relation::ActiveDescendant => relator.active_descendant = target,
            Relation::Controls => relator.controls = target,
            Relation::DescribedBy => {
                match (relator.described_by.is_some(), target.is_some()) {
                    // Its description is its own until now.
                    (false, true) => relator.own_description = own,
                    (true, false) => restore = Some(relator.own_description.take()),
                    _ => {}
                }
                relator.described_by = target;
            }
        }
        if let Some(description) = restore {
            self.apply_relations(
                key,
                Resolved {
                    description: Some(description),
                    ..self.resolved(key)
                },
            );
        }
        if self.relators.iter().any(|r| r.key == key && r.is_empty()) {
            // Cleared: its props lose the ids now, as it leaves the pass.
            self.relators.retain(|r| r.key != key);
            self.apply_relations(key, Resolved::default());
        }
    }

    /// View `key`'s own `accessibilityDescription`: kept apart while it
    /// is described (false: it is not, the description is set as it is).
    pub(super) fn set_own_description(&mut self, key: Key, description: &Option<Arc<str>>) -> bool {
        let Some(r) = self
            .relators
            .iter_mut()
            .find(|r| r.key == key && r.described_by.is_some())
        else {
            return false;
        };
        r.own_description = description.clone();
        true
    }

    /// View `key`'s own `accessibilityDescription`, when it is described
    /// (`None`: it is not, its description is its own).
    pub(super) fn own_description(&self, key: Key) -> Option<Option<Arc<str>>> {
        self.relators
            .iter()
            .find(|r| r.key == key && r.described_by.is_some())
            .map(|r| r.own_description.clone())
    }

    /// The native views the relations of every view name now, and the
    /// text describing it, into their props: before the round's views go
    /// out.
    pub(super) fn sync_relations(&mut self) {
        for i in 0..self.relators.len() {
            let key = self.relators[i].key;
            let resolved = self.resolved(key);
            self.apply_relations(key, resolved);
        }
    }

    /// What the relations of view `key` give it now.
    fn resolved(&self, key: Key) -> Resolved {
        let Some(r) = self.relators.iter().find(|r| r.key == key) else {
            return Resolved::default();
        };
        let named = |t: &Option<ElementTarget>| {
            t.as_ref()
                .and_then(|t| self.key(t.node()?).ok())
                .map(|k| (k, self.nodes[k as usize].id))
        };
        // Only while it is on screen: a region keeps an element it took
        // out until it lets it go, and its text is no longer there.
        let describing = named(&r.described_by).filter(|&(k, _)| self.in_tree(k));
        Resolved {
            active_descendant: named(&r.active_descendant).map(|(_, id)| id),
            controls: named(&r.controls).map(|(_, id)| id),
            described_by: describing.map(|(_, id)| id),
            description: r.described_by.as_ref().map(|_| {
                describing
                    .and_then(|(k, _)| self.describing_text(k))
                    .or_else(|| r.own_description.clone())
            }),
        }
    }

    /// The text of view `key` for a view it describes: its label, else the
    /// labels and texts inside it in order, the hidden ones left out, one
    /// space between them; `None` when it has none. A view named while
    /// hidden still describes, its hidden parts included, as the web's
    /// `aria-describedby` reads a hidden element it names: an error line is
    /// often hidden so that it is read once, with its field.
    fn describing_text(&self, key: Key) -> Option<Arc<str>> {
        let hidden = self.nodes[key as usize]
            .props
            .as_ref()
            .is_some_and(|p| p.accessibility.hidden);
        let mut out = String::new();
        self.push_describing_text(key, false, hidden, &mut out);
        let text = out.trim_end();
        (!text.is_empty()).then(|| Arc::from(text))
    }

    fn push_describing_text(&self, key: Key, inline: bool, hidden: bool, out: &mut String) {
        let node = &self.nodes[key as usize];
        let apart = |out: &mut String| {
            if !out.is_empty() && !out.ends_with(char::is_whitespace) {
                out.push(' ');
            }
        };
        if matches!(node.kind, Kind::RawText) {
            out.push_str(&node.text);
            return;
        }
        if node.is_overlay() {
            return;
        }
        if let Some(a) = node.props.as_ref().map(|p| &p.accessibility) {
            if a.hidden && !hidden {
                return;
            }
            if let Some(label) = &a.label {
                if !inline {
                    apart(out);
                }
                out.push_str(label);
                return;
            }
        }
        let text = matches!(node.kind, Kind::Text);
        if text && !inline {
            apart(out);
        }
        if let Some(run) = self.folded_text(key) {
            out.push_str(run);
        }
        for &child in &node.children {
            self.push_describing_text(child, inline || text, hidden, out);
        }
    }

    fn apply_relations(&mut self, key: Key, resolved: Resolved) {
        let node = &mut self.nodes[key as usize];
        let a = node.props.as_ref().map(|p| &p.accessibility);
        let current = Resolved {
            active_descendant: a.and_then(|a| a.active_descendant),
            controls: a.and_then(|a| a.controls),
            described_by: a.and_then(|a| a.described_by),
            description: resolved
                .description
                .as_ref()
                .map(|_| a.and_then(|a| a.description.clone())),
        };
        if current == resolved {
            return;
        }
        let a = &mut node.props.get_or_insert_default().accessibility;
        a.active_descendant = resolved.active_descendant;
        a.controls = resolved.controls;
        a.described_by = resolved.described_by;
        if let Some(description) = resolved.description {
            a.description = description;
        }
        self.mark(key, dirty::VIEW_PROPS);
    }

    /// Forgets view `key`, being released.
    pub(super) fn release_relator(&mut self, key: Key) {
        self.relators.retain(|r| r.key != key);
    }
}
