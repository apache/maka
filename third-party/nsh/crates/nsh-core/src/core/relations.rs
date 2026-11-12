//! Elements that name other elements for assistive technologies
//! (`accessibilityActiveDescendant`, `accessibilityControls`): a combo
//! box's field names its highlighted option and its listbox, a list that
//! keeps the keyboard focus names its cursor row.
//!
//! The app names an element (a JS ref, or a Rust `ElementRef`), and the
//! platforms get the native view's id in the view's accessibility
//! ([`crate::Accessibility::active_descendant`],
//! [`crate::Accessibility::controls`]). What is named is looked up again
//! before each round's views go out, so it may be rendered after the view
//! naming it (a virtualized list's row, made as the list lays out), go
//! away (scrolled out of a list: the relation names nothing then) or be
//! carried by another element (a ref moved to the row the cursor reached),
//! and the view's props go out again only when the native view named
//! changed.
//!
//! Nothing runs while no view names another: the pass returns at once on
//! an empty `relators`.

use super::{Core, Key, dirty};
use crate::{NodeId, element::ElementTarget, text::TextEngine};

/// What one view names.
#[derive(Debug)]
pub(super) struct Relator {
    key: Key,
    /// Its `accessibilityActiveDescendant`.
    active_descendant: Option<ElementTarget>,
    /// Its `accessibilityControls`.
    controls: Option<ElementTarget>,
}

/// Which relation a prop sets.
#[derive(Debug, Clone, Copy)]
pub(super) enum Relation {
    ActiveDescendant,
    Controls,
}

impl<M: TextEngine> Core<M> {
    /// View `key` names `target` (or nothing) by `relation`.
    pub(super) fn set_relation(
        &mut self,
        key: Key,
        relation: Relation,
        target: Option<ElementTarget>,
    ) {
        let at = self.relators.iter().position(|r| r.key == key);
        let relator = match at {
            Some(i) => &mut self.relators[i],
            None if target.is_none() => return,
            None => {
                self.relators.push(Relator {
                    key,
                    active_descendant: None,
                    controls: None,
                });
                self.relators.last_mut().unwrap()
            }
        };
        match relation {
            Relation::ActiveDescendant => relator.active_descendant = target,
            Relation::Controls => relator.controls = target,
        }
        if relator.active_descendant.is_none() && relator.controls.is_none() {
            // Cleared: its props lose the ids now, as it leaves the pass.
            self.relators.retain(|r| r.key != key);
            self.apply_relations(key, None, None);
        }
    }

    /// The native views the relations of every view name now, into their
    /// props: before the round's views go out.
    pub(super) fn sync_relations(&mut self) {
        for i in 0..self.relators.len() {
            let r = &self.relators[i];
            let key = r.key;
            let active = r.active_descendant.as_ref().and_then(|t| self.named(t));
            let controls = r.controls.as_ref().and_then(|t| self.named(t));
            self.apply_relations(key, active, controls);
        }
    }

    /// The native id of the view `target` names, while one does.
    fn named(&self, target: &ElementTarget) -> Option<NodeId> {
        let key = self.key(target.node()?).ok()?;
        Some(self.nodes[key as usize].id)
    }

    fn apply_relations(&mut self, key: Key, active: Option<NodeId>, controls: Option<NodeId>) {
        let node = &mut self.nodes[key as usize];
        let current = node.props.as_ref().map_or((None, None), |p| {
            (p.accessibility.active_descendant, p.accessibility.controls)
        });
        if current == (active, controls) {
            return;
        }
        let a = &mut node.props.get_or_insert_default().accessibility;
        a.active_descendant = active;
        a.controls = controls;
        self.mark(key, dirty::VIEW_PROPS);
    }

    /// Forgets view `key`, being released.
    pub(super) fn release_relator(&mut self, key: Key) {
        self.relators.retain(|r| r.key != key);
    }
}
