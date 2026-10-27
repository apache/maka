//! Components that run once ([`crate::element::Component::view`]) in the core:
//! their views are mounted with bindings, and what changes later arrives as
//! patches.
//!
//! The view is expanded once, under the component's owner; an element's
//! bound parts (a text, props or a style given as a signal or a closure)
//! become render effects. Each run of one queues a patch with the part's
//! new value; the core applies it against what it applied last (field by
//! field), so a change sends only what changed.
//! A region ([`crate::element::dynamic`], `If`, `Each`) is an effect queueing its
//! new elements; the core reconciles that region's nodes alone, in place
//! among its parent's other children. Patches and the events components emit
//! are taken at the start of each commit round, until none is left.

use std::{cell::RefCell, rc::Rc};

use super::{
    Core,
    components::{Classes, Expanded, Instance, Part, Placement},
};
use crate::{
    NodeId, Op, Tag, TextEngine,
    element::{
        Attrs, BoundListConfig, ElNode, ListConfig, SharedString, StyleRefinement,
        builder::BoundAttrs,
        flow::{Region, RegionElement},
        reactive::render_effect,
    },
};

/// A change a binding of a view queued.
pub(super) enum Patch {
    /// A text's new content.
    Text {
        host: NodeId,
        id: NodeId,
        text: SharedString,
    },
    /// An element's props, the bound ones read again.
    Attrs {
        host: NodeId,
        id: NodeId,
        attrs: Box<Attrs>,
    },
    /// An element's style, the bound parts read again.
    Style {
        host: NodeId,
        id: NodeId,
        style: StyleRefinement,
    },
    /// A region's new elements.
    Region {
        region: u32,
        elements: Vec<RegionElement>,
    },
    /// A list's layout, its bound parts read again.
    Layout { list: NodeId, config: ListConfig },
    /// The styles a view gives a nested component (its host), the bound
    /// parts read again.
    Nested {
        host: NodeId,
        style: StyleRefinement,
    },
    /// The attributes a view gives a nested component (its host) besides
    /// styles, the bound parts read again.
    NestedAttrs { host: NodeId, attrs: Box<Attrs> },
    /// A list's rows, its bound count or keys read again.
    Rows {
        list: NodeId,
        count: u32,
        keys: Option<Rc<[u64]>>,
    },
}

/// The queue the bindings of views push to.
pub(super) type Patches = Rc<RefCell<Vec<Patch>>>;

/// What was last applied to a node with bindings.
pub(super) struct BoundNode {
    pub(super) attrs: Attrs,
    pub(super) style: StyleRefinement,
    pub(super) classes: Classes,
    /// Its text's content and raw text node.
    text: Option<(SharedString, NodeId)>,
}

/// A region of a parent's children.
pub(super) struct RegionState {
    pub(super) host: NodeId,
    parent: NodeId,
    /// What its nodes go before.
    anchor: Anchor,
    /// Its elements, as applied.
    pub(super) children: Vec<Expanded>,
    /// The slot whose fill it is part of, in content of the nested
    /// component `parent`.
    fill: Option<&'static str>,
}

/// What a region's nodes (or a host's JS children) go before in their
/// parent.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Anchor {
    /// The end.
    End,
    Node(NodeId),
    /// The next region's first node, or what it goes before.
    Region(u32),
}

/// The bound parts of an element, taken off it before its static parts are
/// applied.
pub(super) struct Bound {
    text: Option<Rc<dyn Fn() -> SharedString>>,
    attrs: Vec<BoundAttrs>,
    /// The style with its bound parts (none when it has none).
    style: Option<StyleRefinement>,
    /// A list's layout: its static part and its bound parts.
    list: (ListConfig, Vec<BoundListConfig>),
}

impl Bound {
    /// The bound parts of `el`, if it has any (they leave it: what remains
    /// is static).
    pub(super) fn take(el: &mut ElNode) -> Option<Self> {
        if !el.is_bound() {
            return None;
        }
        Some(Self {
            text: el.bound_text.take(),
            attrs: std::mem::take(&mut el.bound_attrs),
            style: el.style.is_bound().then(|| {
                let full = std::mem::take(&mut el.style);
                el.style = full.static_part();
                full
            }),
            list: (
                el.list_config().copied().unwrap_or_default(),
                std::mem::take(&mut el.bound_list),
            ),
        })
    }
}

/// A binding's runs: the first one's value, or a patch for each later one.
///
/// A render effect runs as it is made, so its first value is read while
/// the node is being made and applied with its static parts, once; only what
/// changes later goes through the patch queue.
struct Runs<T> {
    first: Rc<RefCell<Option<T>>>,
    started: std::cell::Cell<bool>,
}

impl<T> Runs<T> {
    fn new() -> (Self, Rc<RefCell<Option<T>>>) {
        let first = Rc::new(RefCell::new(None));
        (
            Self {
                first: first.clone(),
                started: std::cell::Cell::new(false),
            },
            first,
        )
    }

    /// The value of a run: kept if it is the first, else `patch`ed.
    fn run(&self, value: T, patch: impl FnOnce(T)) {
        if self.started.replace(true) {
            patch(value);
        } else {
            *self.first.borrow_mut() = Some(value);
        }
    }
}

impl<M: TextEngine> Core<M> {
    /// Binds the bound parts of node `id` (of `host`'s view) under the
    /// current owner and puts what they read now into `el`, whose parts are
    /// then applied together; their later runs queue patches against what
    /// [`Self::keep_bound`] records.
    pub(super) fn bind_parts(&mut self, host: NodeId, id: NodeId, bound: Bound, el: &mut ElNode) {
        let patches = self.components.patches.clone();
        if let Some(text) = bound.text {
            let patches = patches.clone();
            let (runs, first) = Runs::new();
            render_effect(move || {
                runs.run(text(), |text| {
                    patches.borrow_mut().push(Patch::Text { host, id, text });
                });
            });
            if let Some(text) = first.take() {
                el.text = Some(text);
            }
        }
        if !bound.attrs.is_empty() {
            let base = el.attrs.clone();
            let parts = bound.attrs;
            let patches = patches.clone();
            let (runs, first) = Runs::new();
            render_effect(move || {
                let mut attrs = base.clone();
                for part in &parts {
                    part(&mut attrs);
                }
                runs.run(attrs, |attrs| {
                    patches.borrow_mut().push(Patch::Attrs {
                        host,
                        id,
                        attrs: Box::new(attrs),
                    });
                });
            });
            if let Some(attrs) = first.take() {
                el.attrs = attrs;
            }
        }
        if let Some(style) = bound.style {
            let (runs, first) = Runs::new();
            render_effect(move || {
                runs.run(style.resolved(), |style| {
                    patches.borrow_mut().push(Patch::Style { host, id, style });
                });
            });
            if let Some(style) = first.take() {
                el.style = style;
            }
        }
        let (base, parts) = bound.list;
        if !parts.is_empty() {
            let config = self.bind_list_layout(id, base, parts);
            if let Some(c) = el.list_config() {
                *c = config;
            }
        }
    }

    /// Records what was applied to node `id` of a view with bindings (its
    /// parts with the bindings' first values): what their patches apply
    /// against.
    pub(super) fn keep_bound(
        inst: &mut Instance,
        id: NodeId,
        attrs: &Attrs,
        style: &StyleRefinement,
        classes: Classes,
        text: Option<(SharedString, NodeId)>,
    ) {
        inst.bound.insert(
            id,
            BoundNode {
                attrs: attrs.clone(),
                style: style.clone(),
                classes,
                text,
            },
        );
    }

    /// Binds the styles a view gives nested component `host` under the
    /// current owner: the styles now, to apply; later changes are patches.
    pub(super) fn bind_nested_style(
        &mut self,
        host: NodeId,
        style: StyleRefinement,
    ) -> StyleRefinement {
        let patches = self.components.patches.clone();
        let (runs, first) = Runs::new();
        render_effect(move || {
            runs.run(style.resolved(), |style| {
                patches.borrow_mut().push(Patch::Nested { host, style });
            });
        });
        first.take().unwrap_or_default()
    }

    /// Binds the attributes a view gives nested component `host` (`base`
    /// with the bound `parts`) under the current owner: them now; later
    /// changes are patches.
    pub(super) fn bind_nested_attrs(
        &mut self,
        host: NodeId,
        base: Attrs,
        parts: Vec<crate::element::builder::BoundAttrs>,
    ) -> Attrs {
        let patches = self.components.patches.clone();
        let (runs, first) = Runs::new();
        let resolve = base.clone();
        render_effect(move || {
            let mut attrs = resolve.clone();
            for part in &parts {
                part(&mut attrs);
            }
            runs.run(attrs, |attrs| {
                patches.borrow_mut().push(Patch::NestedAttrs {
                    host,
                    attrs: Box::new(attrs),
                });
            });
        });
        first.take().unwrap_or(base)
    }

    /// Binds the bound parts of list `list`'s layout over `base` under the
    /// current owner: the layout now, to apply; later changes are patches.
    pub(super) fn bind_list_layout(
        &mut self,
        list: NodeId,
        base: ListConfig,
        parts: Vec<BoundListConfig>,
    ) -> ListConfig {
        let patches = self.components.patches.clone();
        let (runs, first) = Runs::new();
        render_effect(move || {
            let mut config = base;
            for part in &parts {
                part(&mut config);
            }
            runs.run(config, |config| {
                patches.borrow_mut().push(Patch::Layout { list, config });
            });
        });
        let config = first.take().unwrap_or(base);
        self.components.list_layouts.insert(list, config);
        config
    }

    /// Makes region `region` of `host`'s view in `parent` a binding under
    /// the current owner; returns its id (its nodes come with its first
    /// patch).
    pub(super) fn bind_region(&mut self, host: NodeId, parent: NodeId, region: Region) -> u32 {
        let id = self.components.next_region;
        self.components.next_region += 1;
        self.components.regions.insert(
            id,
            RegionState {
                host,
                parent,
                anchor: Anchor::End,
                children: Vec::new(),
                fill: self
                    .components
                    .filling
                    .filter(|&(nested, _)| nested == parent)
                    .map(|(_, name)| name),
            },
        );
        let patches = self.components.patches.clone();
        region.bind(Rc::new(move |elements| {
            patches.borrow_mut().push(Patch::Region {
                region: id,
                elements,
            });
        }));
        id
    }

    /// Sets what region `region`'s nodes go before.
    pub(super) fn set_region_anchor(&mut self, region: u32, anchor: Anchor) {
        if let Some(state) = self.components.regions.get_mut(&region) {
            state.anchor = anchor;
        }
    }

    /// The nodes of region `region` now, in order.
    pub(super) fn region_nodes(&self, region: u32) -> Vec<NodeId> {
        self.components
            .regions
            .get(&region)
            .map(|state| state.children.iter().flat_map(|e| self.placed(e)).collect())
            .unwrap_or_default()
    }

    /// The nodes an expanded element puts in its parent (a region its own).
    pub(super) fn placed(&self, e: &Expanded) -> Vec<NodeId> {
        match e.part {
            Part::Region(region) => self.region_nodes(region),
            Part::Fill(_) => e.children.iter().flat_map(|c| self.placed(c)).collect(),
            Part::Filled(_) => Vec::new(),
            _ => vec![e.id],
        }
    }

    /// The first node region `region` puts in its parent now, if any,
    /// without collecting the others ([`Self::region_nodes`]).
    fn first_node(&self, region: u32) -> Option<NodeId> {
        let state = self.components.regions.get(&region)?;
        // (Its host's JS children and fills: known but while its view is
        // reconciled, when its instance is out of the instances.)
        let inst = self.components.instances.get(&state.host).map(|i| &**i);
        state.children.iter().find_map(|e| self.node_of(e, inst))
    }

    /// The node an element of `inst`'s view puts first in its parent now.
    fn node_of(&self, e: &Expanded, inst: Option<&Instance>) -> Option<NodeId> {
        match e.part {
            Part::Children => inst?.js_children.first().copied(),
            Part::Filled(name) => self
                .fill_of(inst?, name)
                .and_then(|f| self.fill_nodes(f).first().copied()),
            Part::Region(region) => self.first_node(region),
            // A slot's: placed by the nested view where it places it.
            Part::Fill(_) => None,
            _ => (e.id != 0).then_some(e.id),
        }
    }

    /// What follows the elements before `elements` (some of `inst`'s view,
    /// all in one parent): the first node among them, the first region
    /// (empty now, it may fill), or `end` past them all (what follows the
    /// region they are, or the end).
    pub(super) fn anchor_after(
        &self,
        elements: &[Expanded],
        inst: &Instance,
        end: Anchor,
    ) -> Anchor {
        elements
            .iter()
            .find_map(|e| match e.part {
                Part::Region(region) => Some(Anchor::Region(region)),
                _ => self.node_of(e, Some(inst)).map(Anchor::Node),
            })
            .unwrap_or(end)
    }

    /// Anchors each region among `out` (`inst`'s view's children, or a
    /// region's) to what follows it: past `out`'s end, `end` (a region in
    /// a region resolves to what follows the outer one, as its nodes do).
    pub(super) fn set_region_anchors(&mut self, out: &[Expanded], inst: &Instance, end: Anchor) {
        for (i, e) in out.iter().enumerate() {
            if let Part::Region(region) = e.part {
                let anchor = self.anchor_after(&out[i + 1..], inst, end);
                self.set_region_anchor(region, anchor);
            }
        }
    }

    /// The node a region's nodes go before (`None`: the end).
    pub(super) fn anchor_node(&self, anchor: Anchor) -> Option<NodeId> {
        let mut anchor = anchor;
        loop {
            match anchor {
                Anchor::End => return None,
                Anchor::Node(id) => return Some(id),
                Anchor::Region(region) => {
                    if let Some(first) = self.first_node(region) {
                        return Some(first);
                    }
                    anchor = self.components.regions.get(&region)?.anchor;
                }
            }
        }
    }

    /// Applies what the views' bindings queued and routes the events their
    /// components emitted, until nothing is left. Whether anything was.
    pub(super) fn drain_views(&mut self) -> bool {
        let mut any = false;
        loop {
            // The insets components read, as their screens have them now.
            for host in self.components.runtime.inset_hosts() {
                let insets = self.insets_of(host);
                self.components.runtime.set_insets(host, insets);
            }
            let emits = self.components.runtime.take_emits();
            let patches = std::mem::take(&mut *self.components.patches.borrow_mut());
            if emits.is_empty() && patches.is_empty() {
                return any;
            }
            any = true;
            for (host, event) in emits {
                self.route_emit(host, event);
            }
            for patch in patches {
                self.apply_patch(patch);
            }
        }
    }

    fn apply_patch(&mut self, patch: Patch) {
        match patch {
            Patch::Region { region, elements } => self.reconcile_region(region, elements),
            Patch::Rows { list, count, keys } => self.set_list_rows(list, count, keys),
            Patch::NestedAttrs { host, attrs } => {
                if self.is_host(host) {
                    self.set_given(host, *attrs);
                }
            }
            Patch::Nested { host, style } => {
                if self.is_host(host) {
                    let user = (!style.is_empty()).then(|| self.components.lowered(&style));
                    self.set_user(host, user);
                }
            }
            Patch::Layout { list, config } => {
                let Some(old) = self.components.list_layouts.get_mut(&list) else {
                    return;
                };
                let old = std::mem::replace(old, config);
                let mut props = Vec::new();
                config.changes(&old, &mut props);
                for prop in props {
                    let _ = self.apply_op(Op::SetProp { id: list, prop });
                }
            }
            Patch::Text { host, id, text } => {
                let Some(inst) = self.components.instances.get_mut(&host) else {
                    return;
                };
                let Some(node) = inst.bound.get_mut(&id) else {
                    return;
                };
                match &mut node.text {
                    Some((old, raw)) if *old != text => {
                        let raw = *raw;
                        *old = text.clone();
                        let _ = self.apply_op(Op::SetText {
                            id: raw,
                            text: text.as_str().to_owned(),
                        });
                    }
                    _ => {}
                }
            }
            Patch::Attrs { host, id, attrs } => {
                // The root: what the views and components above give it
                // goes after its own.
                let cx = if id == host {
                    self.root_context_of(host)
                } else {
                    None
                };
                let Some(inst) = self.components.instances.get_mut(&host) else {
                    return;
                };
                let app = match &cx {
                    Some(cx) if cx.combined => cx.app.clone(),
                    Some(_) => inst.app_style.clone(),
                    None => None,
                };
                let Some(node) = inst.bound.get_mut(&id) else {
                    return;
                };
                let attrs = *attrs;
                let old = std::mem::replace(&mut node.attrs, attrs.clone());
                // The app's classes changed: the styles go again.
                let restyle = (attrs.class != old.class).then(|| {
                    (
                        node.style.clone(),
                        node.classes.clone(),
                        attrs.class.clone(),
                    )
                });
                let (attrs, old) = match &cx {
                    Some(cx) => {
                        let mut old = old;
                        (old.inset_padding, old.inset_margin) = inst.root_insets_applied;
                        let attrs = cx.over(attrs);
                        inst.root_insets_applied = (attrs.inset_padding, attrs.inset_margin);
                        (attrs, old)
                    }
                    None => (attrs, old),
                };
                if self.components.slot_hosts.get(&id) == Some(&host) {
                    // An app's slot: what is not a style goes to its
                    // target (`super::slots`).
                    self.apply_slot_attrs(id, host, &attrs, &old, None);
                } else {
                    self.apply_attrs_over(id, &attrs, &old, app.as_ref());
                }
                if let Some((style, classes, class)) = restyle {
                    let outer = cx.and_then(|cx| cx.user);
                    let classes =
                        self.apply_el_styles(id, &style, &style, classes, class.as_ref(), outer);
                    if let Some(node) = self
                        .components
                        .instances
                        .get_mut(&host)
                        .and_then(|i| i.bound.get_mut(&id))
                    {
                        node.classes = classes;
                    }
                }
            }
            Patch::Style { host, id, style } => {
                let user = if id == host {
                    self.root_context_of(host).and_then(|cx| cx.user)
                } else {
                    None
                };
                let Some(inst) = self.components.instances.get_mut(&host) else {
                    return;
                };
                let Some(node) = inst.bound.get_mut(&id) else {
                    return;
                };
                let old_style = std::mem::replace(&mut node.style, style.clone());
                let old_classes = node.classes.clone();
                let class = node.attrs.class.clone();
                let classes =
                    self.apply_el_styles(id, &style, &old_style, old_classes, class.as_ref(), user);
                if let Some(node) = self
                    .components
                    .instances
                    .get_mut(&host)
                    .and_then(|i| i.bound.get_mut(&id))
                {
                    node.classes = classes;
                }
            }
        }
    }

    /// Region `region`'s new elements, matched with the old ones as an
    /// element's children are (kept rows stay as they are; each element is
    /// applied under its owner), then put in place among the parent's other
    /// children, before the region's anchor.
    fn reconcile_region(&mut self, region: u32, elements: Vec<RegionElement>) {
        let Some(state) = self.components.regions.remove(&region) else {
            return;
        };
        let host = state.host;
        let Some(mut inst) = self.components.instances.remove(&host) else {
            return;
        };
        let parent = state.parent;
        // The JS children were placed by this region: placed again below.
        let old_place = inst.children_at;
        if state.children.iter().any(|e| e.part == Part::Children) {
            inst.children_at = Placement::None;
        }
        // What a run made goes with it unapplied once a later run replaced
        // it or its row went.
        let new = elements
            .into_iter()
            .filter(RegionElement::applies)
            .map(|e| (e.owner, e.element.0))
            .collect();
        let (out, placeholder) = self.match_children(parent, state.children, new, host, &mut inst);
        self.forget_released(host, &mut inst);
        // The JS children's place went with what the region released.
        let gone = match inst.children_at {
            Placement::At(at, _) => at != host && !self.components.owners.contains_key(&at),
            Placement::Nested(nested, _) => !self.is_host(nested),
            _ => false,
        };
        if gone {
            inst.children_at = Placement::None;
        }
        // A nested component's content joins it as JS children do.
        let nested = parent != host && self.is_host(parent);
        let place = |after| {
            if nested {
                Placement::Nested(parent, after)
            } else {
                Placement::At(parent, after)
            }
        };
        // What it holds resolves past its end to what follows it: its
        // regions, the JS children, what fills a slot.
        self.set_region_anchors(&out, &inst, state.anchor);
        if let Some(at) = placeholder {
            inst.children_at = place(self.anchor_after(&out[at + 1..], &inst, state.anchor));
        }
        self.place_filled(&out, &mut inst, state.anchor, place);
        // In place: from the last, each before the next, from the anchor.
        let nodes: Vec<NodeId> = out
            .iter()
            .flat_map(|e| match e.part {
                Part::Children => inst.js_children.clone(),
                Part::Filled(name) => self
                    .fill_of(&inst, name)
                    .map(|f| self.fill_nodes(f))
                    .unwrap_or_default(),
                _ => self.placed(e),
            })
            .collect();
        self.children_placed(host, &mut inst, old_place);
        self.components.instances.insert(host, inst);
        self.components.regions.insert(
            region,
            RegionState {
                host,
                parent,
                anchor: state.anchor,
                children: out,
                fill: state.fill,
            },
        );
        // Part of what fills a nested component's slot: it goes where the
        // nested view places the slot, whose prop follows; what fills this
        // view's own slots and it passes on goes there too.
        if let Some(name) = state.fill {
            if let Some(mut inst) = self.components.instances.remove(&host) {
                self.note_passed(parent, name, host, &mut inst);
                self.components.instances.insert(host, inst);
            }
            self.refill(parent, name);
            return;
        }
        // (Resolved with the host's instance back: a region after this one
        // may hold its JS children.)
        let mut before = self.anchor_node(state.anchor);
        if nested {
            for &child in nodes.iter().rev() {
                if !self.nested_precedes(parent, child, before) {
                    self.join_nested_at(parent, child, before);
                }
                before = Some(child);
            }
        } else {
            self.place_before(parent, &nodes, before);
        }
    }

    /// A region of the fill of slot `name` of the nested component hosted
    /// by `nested` changed: the nested view places the fill's nodes again,
    /// and its slot prop follows whether there are any.
    fn refill(&mut self, nested: NodeId, name: &'static str) {
        self.components.mark(nested);
        self.place_fill(nested, name);
    }

    /// Forgets what `host`'s view knew of the nodes released since: their
    /// handlers, responders and bindings.
    fn forget_released(&self, host: NodeId, inst: &mut Instance) {
        // The app's slot nodes are JS's, not the view's: they keep what the
        // view gave them while they are its slots (and so do the app's
        // elements in them that take the slots' props).
        let live = |id: &NodeId| {
            *id == host
                || self.components.owners.contains_key(id)
                || self.components.slot_hosts.get(id) == Some(&host)
                || self.adopted_host(*id) == Some(host)
        };
        inst.handlers.retain(|(id, _, _)| live(id));
        inst.event_handlers.retain(|(id, _)| live(id));
        inst.responders.retain(|(id, _)| live(id));
        inst.bound.retain(|id, _| live(id));
    }

    /// Releases the regions of `host`'s view (the host goes).
    pub(super) fn release_regions(&mut self, host: NodeId) {
        let regions: Vec<u32> = self
            .components
            .regions
            .iter()
            .filter(|(_, s)| s.host == host)
            .map(|(&id, _)| id)
            .collect();
        // Their nodes go too (a region inside another is released with it).
        for region in regions {
            self.release_region(region);
        }
    }

    /// Releases region `region`'s nodes (its placeholder goes).
    pub(super) fn release_region(&mut self, region: u32) {
        if let Some(state) = self.components.regions.remove(&region) {
            for e in state.children {
                self.release_expanded(e);
            }
        }
    }
}

/// A placeholder element for a region of `tag` (it has no node).
pub(super) fn region_placeholder(region: u32) -> Expanded {
    let mut e = Expanded::js(0, Part::Region(region));
    e.tag = Tag::View;
    e
}
