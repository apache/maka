//! The app's JS functions Rust components render with
//! ([`crate::element::Renderer`]): which (prop, key) of which component's host
//! is placed where, the value JS rendered last for each, and the holder
//! view JS rendered it into.
//!
//! A placeholder is a view of a component's view whose element carries a
//! [`RenderPlace`] (`Attrs::render`), registered when the element is
//! applied and forgotten when it changes or goes. After each commit
//! ([`Core::flush_renders`]) the core asks JS to render each (prop, key)
//! placed with a value it did not render yet (`JsEvent::Render`), and
//! tells it when none is placed any more (`JsEvent::Unrender`). JS inserts
//! its holder (`componentRender`) into the component's host; the core
//! places it as the only child of the (prop, key)'s placeholder (the last
//! one placed, when the view places a key twice). Apps that render nothing
//! this way pay nothing: every path starts with a check of an empty map.

use std::{rc::Rc, sync::Arc};

use rustc_hash::FxHashMap;

use super::{Core, Key, NO_KEY};
use crate::{
    NodeId, Op, TextEngine,
    element::{
        JsEvent, RenderValue, SharedString,
        renderer::{RenderAt, RenderPlace},
    },
};

/// The renders of the components' views.
#[derive(Default)]
pub(super) struct Renders {
    /// Placeholders -> what they place.
    places: FxHashMap<NodeId, Rc<RenderPlace>>,
    /// (the component's host, the prop and key as JS names them) -> its
    /// state.
    slots: FxHashMap<(NodeId, Arc<str>), RenderSlot>,
    /// The holders JS made -> their (prop, key), and the host JS inserted
    /// them into (0: none yet).
    holders: FxHashMap<NodeId, (Arc<str>, NodeId)>,
    /// The slots whose places changed since the last flush.
    dirty: Vec<(NodeId, Arc<str>)>,
}

impl Renders {
    /// Whether no placeholder is placed.
    pub(super) fn is_empty(&self) -> bool {
        self.places.is_empty()
    }
}

/// A (prop, key) of a component's host.
struct RenderSlot {
    prop: &'static str,
    key: SharedString,
    /// The placeholders placing it, oldest first: the last one shows it.
    places: Vec<NodeId>,
    /// The value JS was asked to render last.
    sent: Option<Rc<dyn RenderValue>>,
    /// JS's holder of what it rendered.
    holder: Option<NodeId>,
}

impl<M: TextEngine> Core<M> {
    /// Element `id`'s render changed from `old` to `new` (its attributes
    /// were applied).
    pub(super) fn update_render(
        &mut self,
        id: NodeId,
        old: Option<&RenderAt>,
        new: Option<&RenderAt>,
    ) {
        // The same (prop, key) with another value: the holder stays.
        if let (Some(old), Some(new)) = (old, new)
            && old.0.host == new.0.host
            && old.0.prop == new.0.prop
            && old.0.key == new.0.key
        {
            let renders = &mut self.components.renders;
            renders.places.insert(id, new.0.clone());
            renders.dirty.push((new.0.host, new.0.slot()));
            return;
        }
        if old.is_some() {
            self.forget_render_place(id);
        }
        let Some(new) = new else { return };
        let slot = new.0.slot();
        let key = (new.0.host, slot.clone());
        let renders = &mut self.components.renders;
        renders.places.insert(id, new.0.clone());
        let entry = renders
            .slots
            .entry(key.clone())
            .or_insert_with(|| RenderSlot {
                prop: new.0.prop,
                key: new.0.key.clone(),
                places: Vec::new(),
                sent: None,
                holder: None,
            });
        entry.places.retain(|&p| p != id);
        entry.places.push(id);
        renders.dirty.push(key);
    }

    /// Placeholder `id` no longer places its render (it changed or went):
    /// the holder leaves it.
    pub(super) fn forget_render_place(&mut self, id: NodeId) {
        let renders = &mut self.components.renders;
        let Some(place) = renders.places.remove(&id) else {
            return;
        };
        let key = (place.host, place.slot());
        let mut leaves = None;
        if let Some(slot) = renders.slots.get_mut(&key) {
            if slot.places.last() == Some(&id) {
                leaves = slot.holder;
            }
            slot.places.retain(|&p| p != id);
        }
        renders.dirty.push(key);
        if let Some(holder) = leaves {
            self.detach_id(holder);
        }
    }

    /// `componentRender` on a view: JS's holder of a render.
    pub(super) fn set_render_holder(&mut self, id: NodeId, slot: Arc<str>) {
        self.components.renders.holders.insert(id, (slot, 0));
    }

    /// Whether `id` is a render's holder.
    pub(super) fn is_render_holder(&self, id: NodeId) -> bool {
        !self.components.renders.holders.is_empty()
            && self.components.renders.holders.contains_key(&id)
    }

    /// JS inserts holder `holder` into component host `host`: it goes into
    /// its placeholder, replacing the holder rendered before; with none
    /// placed, it waits out of the tree for JS to release it (an
    /// `Unrender` is on its way).
    pub(super) fn insert_render_holder(&mut self, host: NodeId, holder: NodeId) {
        let renders = &mut self.components.renders;
        let Some(entry) = renders.holders.get_mut(&holder) else {
            return;
        };
        entry.1 = host;
        let key = (host, entry.0.clone());
        let (old, place) = match renders.slots.get_mut(&key) {
            Some(slot) => (
                slot.holder.replace(holder).filter(|&h| h != holder),
                slot.places.last().copied(),
            ),
            None => (None, None),
        };
        if let Some(old) = old {
            self.detach_id(old);
        }
        match place {
            Some(place) => {
                let _ = self.apply_op(Op::Insert {
                    parent: place,
                    child: holder,
                    before: None,
                });
            }
            None => self.detach_id(holder),
        }
    }

    /// JS removes holder `holder` from its host (or releases it).
    pub(super) fn remove_render_holder(&mut self, holder: NodeId, released: bool) {
        let renders = &mut self.components.renders;
        let entry = if released {
            renders.holders.remove(&holder)
        } else {
            renders.holders.get(&holder).cloned()
        };
        if let Some((slot, host)) = entry
            && let Some(slot) = renders.slots.get_mut(&(host, slot))
            && slot.holder == Some(holder)
        {
            slot.holder = None;
        }
        if !released {
            self.detach_id(holder);
        }
    }

    /// The list cells whose content waits for JS: they (or a cell inside
    /// them) hold the placeholder of a render whose holder has not arrived
    /// yet, into `out`, sorted. Their size is the size of empty
    /// placeholders until it does, so their lists do not measure them.
    pub(super) fn cells_awaiting_renders(&self, out: &mut Vec<Key>) {
        out.clear();
        let renders = &self.components.renders;
        if self.lists.is_empty() || renders.places.is_empty() {
            return;
        }
        for slot in renders.slots.values() {
            if slot.holder.is_some() {
                continue;
            }
            let Some(mut k) = slot.places.last().and_then(|&p| self.key(p).ok()) else {
                continue;
            };
            loop {
                let parent = self.nodes[k as usize].parent;
                if parent == NO_KEY {
                    break;
                }
                // A list's children are its cells.
                if self.nodes[parent as usize].list.is_some() {
                    out.push(k);
                }
                k = parent;
            }
        }
        out.sort_unstable();
        out.dedup();
    }

    /// After a commit's views: asks JS to render what is placed with a
    /// value it has not rendered, puts holders in their placeholders, and
    /// tells JS of the renders no longer placed.
    pub(super) fn flush_renders(&mut self) {
        if self.components.renders.dirty.is_empty() {
            return;
        }
        let dirty = std::mem::take(&mut self.components.renders.dirty);
        for key in dirty {
            let renders = &mut self.components.renders;
            let Some(slot) = renders.slots.get_mut(&key) else {
                continue;
            };
            let Some(&place) = slot.places.last() else {
                let slot = renders.slots.remove(&key).expect("a slot");
                if slot.sent.is_some() {
                    self.events.push(JsEvent::Unrender {
                        host: key.0,
                        prop: slot.prop,
                        key: slot.key,
                    });
                }
                if let Some(holder) = slot.holder {
                    self.detach_id(holder);
                }
                continue;
            };
            let value = renders.places[&place].value.clone();
            if !slot.sent.as_ref().is_some_and(|v| v.same(&*value)) {
                slot.sent = Some(value.clone());
                self.events.push(JsEvent::Render {
                    host: key.0,
                    prop: slot.prop,
                    key: slot.key.clone(),
                    value,
                });
            }
            // Its placeholder may be another one now.
            if let Some(holder) = slot.holder {
                let placed = self.key(holder).is_ok_and(|k| {
                    let parent = self.nodes[k as usize].parent;
                    parent != NO_KEY && self.nodes[parent as usize].id == place
                });
                if !placed {
                    let _ = self.apply_op(Op::Insert {
                        parent: place,
                        child: holder,
                        before: None,
                    });
                }
            }
        }
    }
}
