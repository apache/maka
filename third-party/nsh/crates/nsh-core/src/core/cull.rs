//! Scroll views make the native views of their content near their
//! viewport only (`EngineConfig::content_culling`). The rows of an
//! `<Each>` far from it wait as placeholders sized like the rows rendered
//! (`Op::Placeholder`): JS renders a row once its placeholder would be
//! made (`JsEvent::Rows`).
//!
//! A view whose transform moves it culls with its rectangle widened by how
//! far the transform may take it ([`Core::reach_of`]): a static translation
//! or one animated by values the core can bound (`animation/reach.rs`), as
//! a section's entrance slides it a few points. A transform it cannot bound
//! (a scale, a rotation, a gesture's or a scroll view's value) keeps the
//! view and what it holds made with their parent.

use taffy::Position;

use super::{Core, Key, Kind, NO_KEY, Origin, rounded, scroll_extent};
use crate::{geometry::Bounds, mount::MountItem, ops::EventKind, text::TextEngine};

/// How far around its viewport a scroll view mounts its content, in
/// viewports on each side (as lists' overscan).
const OVERSCAN: f32 = 1.0;

/// How far from its viewport a scroll view lets made views go again, in
/// viewports on each side: further than [`OVERSCAN`], so a view scrolled
/// a little out and back stays.
const RECLAIM: f32 = 3.0;

/// The most views a subtree given up may have: a larger one is kept, so
/// the check stays cheap on every scroll.
const RECLAIM_MAX_NODES: usize = 200;

/// How high a placeholder is until rows rendered beside it give its size.
const PLACEHOLDER_HEIGHT: f32 = 44.0;

impl<M: TextEngine> Core<M> {
    /// The scroll view that culls the children of `parent` (`parent`
    /// itself, or the nearest scroll view around it), when there is one.
    pub(super) fn cull_scope(&self, parent: Key) -> Option<Key> {
        // A terminal's views are its Cells, as cheap as the core's nodes,
        // and its search and focus keys read all of them.
        if self.layout.grid().is_some() || !self.culls_content {
            return None;
        }
        let mut key = parent;
        while key != NO_KEY {
            let node = &self.nodes[key as usize];
            if node.list.is_some() || node.kind == Kind::Cell || node.is_layout_root() {
                return None;
            }
            // A view inside a text (an attachment) is laid out on its own
            // and placed by its text, which makes it with its view:
            // culling's walk never reaches into it, so what it holds
            // would wait for good.
            if node.inline && node.kind != Kind::Text && node.layout.is_some() {
                return None;
            }
            if node.kind == Kind::Scroll {
                return node
                    .scroll
                    .as_ref()
                    .is_some_and(|s| !s.behavior.zooms())
                    .then_some(key);
            }
            // Content that moves as a whole by more than can be told: where
            // its children show is not near their frames. A translation of
            // known reach widens their rectangles instead (`sync_culled_in`).
            self.reach_of(key)?;
            key = node.parent;
        }
        None
    }

    /// Whether `key` is made with its parent wherever it is: it may show
    /// away from its frame, or lays out on its own (a dialog's modal, which
    /// [`Core::sync_culled`] never comes back to).
    pub(super) fn never_culled(&self, key: Key) -> bool {
        let node = &self.nodes[key as usize];
        node.sticky.is_some()
            || node.follow.is_some()
            || node.decoration
            || node.is_overlay()
            || node.is_layout_root()
            || self.reach_of(key).is_none()
    }

    /// How far `key`'s transform may move it from its frame, in points
    /// along x and along y (either way): `(0, 0)` without one; `None` when
    /// that cannot be told, for a scale, a rotation, a skew or a
    /// perspective, or a translation by a value without a bound (a
    /// gesture's, a scroll view's: `animation/reach.rs`). Animated
    /// opacity and colors move nothing.
    pub(super) fn reach_of(&self, key: Key) -> Option<(f32, f32)> {
        use crate::{animation::AnimationProp, transform::TransformKind};
        let node = &self.nodes[key as usize];
        let ops = node.view_style.transform.ops();
        if ops.is_empty() {
            return Some((0.0, 0.0));
        }
        let (mut x, mut y) = (0.0f32, 0.0f32);
        for (i, op) in ops.iter().enumerate() {
            let animated = node
                .animated
                .iter()
                .find(|(prop, _)| *prop == AnimationProp::Transform(i as u8))
                .map(|&(_, value)| value);
            let (lo, hi) = match animated {
                Some(value) => self.reach.range(value)?,
                None => (op.value, op.value),
            };
            let far = lo.abs().max(hi.abs());
            let size = node.frame.size;
            match op.kind {
                TransformKind::TranslateX => x += far,
                TransformKind::TranslateY => y += far,
                TransformKind::TranslateXFraction if size.width.0.is_finite() => {
                    x += far * size.width.0
                }
                TransformKind::TranslateYFraction if size.height.0.is_finite() => {
                    y += far * size.height.0
                }
                // An entry that changes nothing (a scale of 1).
                kind if animated.is_none() && op.value == kind.identity() => {}
                _ => return None,
            }
        }
        (x.is_finite() && y.is_finite()).then_some((x, y))
    }

    /// Holds back `child`, about to be made in `scope`'s content, when it
    /// may be culled; whether it was.
    pub(super) fn hold_back(&mut self, scope: Option<Key>, child: Key) -> bool {
        if self.nodes[child as usize].placeholder && (scope.is_none() || self.never_culled(child)) {
            // Nothing culls it: its row is rendered in its place now.
            self.ask_row(child);
            return true;
        }
        let Some(scope) = scope else {
            return self.pace_hold(child);
        };
        if self.nodes[child as usize].created || self.never_culled(child) {
            return false;
        }
        self.nodes[child as usize].culled = true;
        if let Some(scroll) = self.nodes[scope as usize].scroll.as_mut()
            && !scroll.culls
        {
            scroll.culls = true;
            self.culling.push(scope);
        }
        self.cull_dirty = true;
        true
    }

    /// The frame of culled `key` and its subtree's, as
    /// [`Core::emit_frames_in`] gives made views theirs, with no mount
    /// items: what `onLayout`, `measure()` and [`Core::sync_culled`] read.
    pub(super) fn cull_frames_in(&mut self, key: Key, hidden: bool, origin: Origin) {
        let node = &mut self.nodes[key as usize];
        node.culled = true;
        let Some(layout) = node.layout else { return };
        let hidden = hidden || self.layout.displays_none(layout);
        let unrounded = *self.layout.unrounded_layout(layout);
        // Placed in a containing block further up, as `emit_frames_in`
        // places it.
        let position = self.layout.style(layout).position;
        let escaping = position == Position::Fixed
            || (position == Position::Absolute
                && !self
                    .layout
                    .parent(layout)
                    .is_some_and(|p| self.layout.style(p).position.is_positioned()));
        let containing = if escaping {
            self.containing_origin(layout)
        } else {
            origin
        };
        let ratio = self.frame_ratio();
        let frame = if hidden {
            Bounds::default()
        } else {
            let l = rounded(&unrounded, containing, ratio);
            let offset = origin.to(containing, ratio);
            let mut frame = crate::geometry::rect(
                l.location.x + offset.x,
                l.location.y + offset.y,
                l.size.width,
                l.size.height,
            );
            // A scroll view's content size, sent with the frame when it is
            // made (a list's view in its parent's viewport has none).
            let node = &mut self.nodes[key as usize];
            if node.kind == Kind::Scroll
                && let Some(scroll) = node.scroll.as_mut()
            {
                scroll.culled_content = Some(scroll_extent(&l, scroll.horizontal));
            }
            if let Some(parent) = self.nodes.get(self.nodes[key as usize].parent as usize)
                && parent.rtl
                && parent.kind == Kind::Scroll
                && let Some(scroll) = parent.scroll.as_deref()
                && scroll.horizontal
                && let Some(content) = scroll.content
            {
                frame.origin.x = content.width - frame.origin.x - frame.size.width;
            }
            frame
        };
        let node = &mut self.nodes[key as usize];
        // Laid out again whenever it is made.
        node.emitted = None;
        if node.frame != frame {
            node.frame = frame;
            if node.events.contains(EventKind::Layout) {
                self.events.push(crate::element::JsEvent::Event(
                    node.id,
                    EventKind::Layout,
                    crate::ops::EventPayload::Layout(frame),
                ));
            }
        }
        self.layout.emitted(layout);
        let node = &self.nodes[key as usize];
        if !node.kind.is_container() || node.kind == Kind::List {
            return;
        }
        let inner = Origin::of(
            taffy::Point {
                x: containing.at.x + unrounded.location.x,
                y: containing.at.y + unrounded.location.y,
            },
            unrounded.size,
            ratio,
        );
        let children = std::mem::take(&mut self.nodes[key as usize].children);
        for &child in &children {
            let c = &self.nodes[child as usize];
            if !c.is_layout_root() && !c.created {
                self.cull_frames_in(child, hidden, inner);
            }
        }
        self.nodes[key as usize].children = children;
    }

    /// Scroll view `key` scrolled or was laid out again: what it culls is
    /// looked at again in this commit.
    pub(super) fn cull_moved(&mut self, key: Key) {
        if self.nodes[key as usize]
            .scroll
            .as_ref()
            .is_some_and(|s| s.culls)
        {
            self.cull_dirty = true;
        }
    }

    /// Whether scroll views mount their content as it comes near
    /// (`cull.rs`, the default), or all of it as it is made: what a test
    /// driver reads (`nsh test`'s steps reach every view of a page, as
    /// they always did). Turned off, what is culled is made in the next
    /// commit.
    pub fn set_content_culling(&mut self, enabled: bool) {
        if self.culls_content == enabled {
            return;
        }
        self.culls_content = enabled;
        // Off: what is culled is made. On again: what went far away while
        // it was off is given up (the scroll views stay in `culling`).
        if !self.culling.is_empty() {
            self.cull_dirty = true;
        }
    }

    /// Makes the culled views that came within the window of the scroll
    /// views around them; whether it made any (their styles, texts and
    /// images then go out in another round of the commit).
    pub(super) fn sync_culled(&mut self) -> bool {
        self.cull_dirty = false;
        let mut made = false;
        let mut i = 0;
        while i < self.culling.len() {
            let scope = self.culling[i];
            let (made_here, left) = self.sync_culled_in(scope);
            made |= made_here;
            if left {
                i += 1;
            } else {
                // Gone, or everything in it made with culling off.
                if let Some(scroll) = self
                    .nodes
                    .get_mut(scope as usize)
                    .and_then(|n| n.scroll.as_mut())
                {
                    scroll.culls = false;
                }
                self.culling.swap_remove(i);
            }
        }
        made
    }

    /// [`Core::sync_culled`] in scroll view `scope`: whether it made views,
    /// and whether it is still to be looked at (some of its content is
    /// culled, or may be given up as it scrolls).
    fn sync_culled_in(&mut self, scope: Key) -> (bool, bool) {
        let Some(node) = self.nodes.get(scope as usize) else {
            return (false, false);
        };
        let Some(scroll) = node.scroll.as_deref() else {
            return (false, false);
        };
        // Gone (its slot may hold another node now).
        if node.kind != Kind::Scroll || !scroll.culls {
            return (false, false);
        }
        // Not made or not placed yet: looked at once it is.
        if !node.created || node.frame.origin.x.0.is_nan() || !self.in_tree(scope) {
            return (false, true);
        }
        let (w, h) = (node.frame.size.width.0, node.frame.size.height.0);
        let (x, y) = scroll.offset;
        let window = (
            x - w * OVERSCAN,
            y - h * OVERSCAN,
            x + w * (1.0 + OVERSCAN),
            y + h * (1.0 + OVERSCAN),
        );
        let far = (
            x - w * RECLAIM,
            y - h * RECLAIM,
            x + w * (1.0 + RECLAIM),
            y + h * (1.0 + RECLAIM),
        );
        let holders = self.view_holders();
        let mut made = false;
        let mut stack = std::mem::take(&mut self.cull_scratch);
        stack.clear();
        stack.push((scope, 0.0f32, 0.0f32, 0.0f32, 0.0f32));
        // `ex`, `ey`: how far the transforms between the scroll view and
        // `parent` may move what it holds; each child's rectangle is
        // widened by them and its own (`Core::reach_of`).
        while let Some((parent, px, py, ex, ey)) = stack.pop() {
            let mut i = 0;
            while let Some(&child) = self.nodes[parent as usize].children.get(i) {
                i += 1;
                let c = &self.nodes[child as usize];
                if c.layout.is_none() || c.is_layout_root() {
                    continue;
                }
                let f = c.frame;
                let (cx, cy) = (px + f.origin.x.0, py + f.origin.y.0);
                let (cw, ch) = (f.size.width.0, f.size.height.0);
                // Where its transforms may take it: without a bound, it
                // shows wherever it is.
                let (ox, oy) = self
                    .reach_of(child)
                    .unwrap_or((f32::INFINITY, f32::INFINITY));
                let (rx, ry) = (ex + ox, ey + oy);
                // Its rectangle widened by them (left, top, right, bottom).
                let r = (cx - rx, cy - ry, cx + cw + rx, cy + ch + ry);
                let meets =
                    |w: (f32, f32, f32, f32)| r.0 < w.2 && r.1 < w.3 && r.2 > w.0 && r.3 > w.1;
                let c = &self.nodes[child as usize];
                if c.created {
                    // Far away, holding nothing a view keeps: given up.
                    let away = cw > 0.0 && ch > 0.0 && !meets(far);
                    if away && self.culls_content && self.reclaimable(child, &holders) {
                        self.reclaim(child);
                        continue;
                    }
                    let c = &self.nodes[child as usize];
                    if c.kind.is_container() && c.kind != Kind::Scroll && c.list.is_none() {
                        stack.push((child, cx, cy, rx, ry));
                    }
                    continue;
                }
                if !c.culled {
                    continue;
                }
                // Not placed yet (NaN), empty (what it holds may overflow
                // it), or within the window.
                let near = meets(window);
                let shows = !self.culls_content
                    || f.origin.x.0.is_nan()
                    || cw <= 0.0
                    || ch <= 0.0
                    || near
                    || self.never_culled(child);
                if !shows {
                    continue;
                }
                if self.nodes[child as usize].placeholder {
                    self.ask_row(child);
                    continue;
                }
                // In the overscan, not in sight: within the turn's budget
                // (`pace.rs`).
                let seen = meets((x, y, x + w, y + h));
                if self.culls_content
                    && !seen
                    && !f.origin.x.0.is_nan()
                    && cw > 0.0
                    && ch > 0.0
                    && !self.never_culled(child)
                    && !self.pace_overscan()
                {
                    continue;
                }
                self.make_culled(parent, child);
                made = true;
                if self.nodes[child as usize].kind.is_container() {
                    stack.push((child, cx, cy, rx, ry));
                }
            }
        }
        self.cull_scratch = stack;
        // Still to be looked at as it scrolls, though all its content is
        // made: what is far away is given up (with culling off too, so that
        // turned on again it gives up what went far away meanwhile).
        (made, true)
    }

    /// Makes culled `child`'s native view in made `parent`'s, at its place
    /// among its siblings, with the frame the core has for it.
    pub(super) fn make_culled(&mut self, parent: Key, child: Key) {
        self.ensure_created(child);
        let before = self.native_before(parent, child);
        self.mount.push(MountItem::Insert {
            parent: self.nodes[parent as usize].id,
            child: self.nodes[child as usize].id,
            before,
        });
        self.cull_made = true;
    }

    /// Makes culled `key` and the culled views around it (a command for it
    /// needs its native view); whether it is made now.
    pub(super) fn uncull(&mut self, key: Key) -> bool {
        let mut chain = Vec::new();
        let mut k = key;
        while k != NO_KEY && !self.nodes[k as usize].created {
            if !self.nodes[k as usize].culled {
                return false;
            }
            chain.push(k);
            k = self.nodes[k as usize].parent;
        }
        if k == NO_KEY {
            return false;
        }
        for &node in chain.iter().rev() {
            let parent = self.nodes[node as usize].parent;
            self.make_culled(parent, node);
        }
        self.nodes[key as usize].created
    }

    /// Makes any culled descendants of made `root` that no longer sit under
    /// an outer scroll view's culling scope (for example, a view promoted to
    /// `position: fixed`, which becomes a layout root that the outer scroll
    /// view's `sync_culled_in` skips). Stops at nested scroll views, lists,
    /// overlays, and layout roots, which manage their own subtrees.
    pub(super) fn uncull_subtree(&mut self, root: Key) {
        let node = &self.nodes[root as usize];
        if !node.created
            || !node.kind.is_container()
            || node.kind == Kind::Scroll
            || node.list.is_some()
        {
            return;
        }
        let mut stack = vec![root];
        while let Some(parent) = stack.pop() {
            let mut i = 0;
            while let Some(&child) = self.nodes[parent as usize].children.get(i) {
                i += 1;
                let c = &self.nodes[child as usize];
                if c.layout.is_none() || c.is_layout_root() || c.is_overlay() {
                    continue;
                }
                if c.created {
                    if c.kind.is_container() && c.kind != Kind::Scroll && c.list.is_none() {
                        stack.push(child);
                    }
                    continue;
                }
                if c.culled {
                    if c.placeholder {
                        self.ask_row(child);
                    } else {
                        self.make_culled(parent, child);
                    }
                }
            }
        }
    }

    /// Text block `key` gets its view: what it was laid out with while
    /// culled, an estimate, gives way to its measured size in the next
    /// layout, which keeps what the scroll views show where it is
    /// (`resize_anchor.rs`), as text that waited through a resize does.
    pub(super) fn measure_for_real(&mut self, key: Key) {
        let Some(layout) = self.nodes[key as usize].layout else {
            return;
        };
        let Some(super::LeafContext::Text(cx)) = self.layout.get_node_context_mut(layout) else {
            return;
        };
        cx.deferred = false;
        if std::mem::take(&mut cx.estimated) {
            cx.cache = None;
            cx.baseline = None;
            cx.min_content = None;
            self.layout.mark_dirty(layout);
            self.needs_layout = true;
            self.resize_settling = true;
        }
    }

    /// The nodes whose views must outlive scrolling away: the focus, the
    /// hosts of open overlays and the ends of a text selection.
    fn view_holders(&self) -> Vec<Key> {
        let mut holders: Vec<Key> = self
            .selection_kept
            .iter()
            .filter_map(|&id| self.key(id).ok())
            .collect();
        if let Some((key, _)) = self.focus {
            holders.push(key);
        }
        // A reveal is resolved after layout; its target must survive the
        // culling pass until that command has its text attachment's position.
        holders.extend(self.commands.iter().filter_map(|(id, command)| {
            matches!(command, crate::Command::Reveal(_))
                .then(|| self.key(*id).ok())
                .flatten()
        }));
        holders.extend(
            self.overlays
                .iter()
                .filter_map(|&o| self.overlay(o).and_then(|o| o.host))
                .filter_map(|id| self.key(id).ok()),
        );
        holders
    }

    /// Whether made `key`'s views may go, to be made again as it comes
    /// back: nothing in it keeps state in its native view (a field, a
    /// player, a page, a scroll position, a component), holds the focus,
    /// an overlay or a selection, is pressed or hovered, or may show
    /// away from its frame; and it is small enough to tell.
    fn reclaimable(&self, key: Key, holders: &[Key]) -> bool {
        use crate::tailwind::state;
        let live = state::PRESSED | state::HOVERED | state::FOCUSED | state::FOCUS_WITHIN;
        let mut stack = vec![key];
        let mut seen = 0;
        while let Some(k) = stack.pop() {
            seen += 1;
            if seen > RECLAIM_MAX_NODES {
                return false;
            }
            let node = &self.nodes[k as usize];
            let keeps = matches!(
                node.kind,
                Kind::Input
                    | Kind::WebView
                    | Kind::Video
                    | Kind::Native
                    | Kind::Canvas
                    | Kind::Shader
                    | Kind::GpuView
                    | Kind::Scroll
                    | Kind::List
                    | Kind::Stack
            ) || node.kind.is_root()
                || node.component.is_some()
                // Its animation bindings go with its view.
                || !node.animated.is_empty()
                || node.states & live != 0
                || node.layout.is_some() && self.never_culled(k)
                || holders.contains(&k);
            if keeps {
                return false;
            }
            stack.extend(node.children.iter().copied());
        }
        true
    }

    /// Gives up the views of made `key`'s subtree: it is culled again, its
    /// layout and measurements kept, and made again as it comes near.
    fn reclaim(&mut self, key: Key) {
        let id = self.nodes[key as usize].id;
        self.mount.push(MountItem::Remove { id });
        // Children first, each from the view it is in.
        let mut order = Vec::new();
        let mut stack = vec![key];
        while let Some(k) = stack.pop() {
            let node = &self.nodes[k as usize];
            if !node.created {
                continue;
            }
            order.push(k);
            stack.extend(node.children.iter().copied());
        }
        for &k in order.iter().rev() {
            let node = &mut self.nodes[k as usize];
            node.created = false;
            node.culled = true;
            node.emitted = None;
            node.overflow = None;
            let (id, layout, text) = (node.id, node.layout, node.kind == Kind::Text);
            self.mount.push(MountItem::Delete { id });
            if text
                && let Some(layout) = layout
                && let Some(super::LeafContext::Text(cx)) = self.layout.get_node_context_mut(layout)
            {
                // Its next view gets its text again.
                cx.laid_out = None;
            }
        }
        self.tree_order_changed |= self.track_tree_order;
        self.tab_places_stale = true;
    }

    /// View `key` is the placeholder of an `<Each>` row
    /// ([`crate::Op::Placeholder`]).
    pub(super) fn placeholder(&mut self, key: Key) {
        let node = &mut self.nodes[key as usize];
        if node.placeholder || node.kind != Kind::View {
            return;
        }
        node.placeholder = true;
        self.placeholders.push((key, node.id));
        if let Some(layout) = node.layout {
            let mut style = self.layout.style(layout).clone();
            style.size.height = taffy::Dimension::length(PLACEHOLDER_HEIGHT);
            self.layout.set_style(layout, style);
        }
    }

    /// Asks JS to render the row of placeholder `key` (once).
    pub(super) fn ask_row(&mut self, key: Key) {
        let node = &mut self.nodes[key as usize];
        if !node.row_asked {
            node.row_asked = true;
            self.asked_rows.push(node.id);
        }
    }

    /// Sizes each placeholder as the rows rendered beside it are on
    /// average (as lists estimate rows not measured); whether any changed
    /// (then laid out again).
    pub(super) fn size_placeholders(&mut self) -> bool {
        let mut sizes: Vec<(Key, Option<(f32, f32)>)> = Vec::new();
        let mut changed = false;
        let mut i = 0;
        while i < self.placeholders.len() {
            let (key, id) = self.placeholders[i];
            // Released (its key may be another node's now).
            if !self
                .nodes
                .get(key as usize)
                .is_some_and(|n| n.id == id && n.placeholder)
            {
                self.placeholders.swap_remove(i);
                continue;
            }
            i += 1;
            let node = &self.nodes[key as usize];
            let (parent, layout) = (node.parent, node.layout);
            // Its row replaces it soon.
            let Some(layout) = layout.filter(|_| parent != NO_KEY && !node.row_asked) else {
                continue;
            };
            let size = match sizes.iter().find(|(p, _)| *p == parent) {
                Some(&(_, size)) => size,
                None => {
                    let size = self.rendered_size(parent);
                    sizes.push((parent, size));
                    size
                }
            };
            let Some((width, height)) = size else {
                continue;
            };
            let style = self.layout.style(layout);
            if near(style.size.width, width) && near(style.size.height, height) {
                continue;
            }
            let mut style = style.clone();
            style.size = taffy::Size {
                width: taffy::Dimension::length(width),
                height: taffy::Dimension::length(height),
            };
            self.layout.set_style(layout, style);
            changed = true;
        }
        if changed {
            self.needs_layout = true;
            self.placeholders_resized = true;
            // What the scroll views show stays where it is.
            self.resize_settling = true;
        }
        changed
    }

    /// The average size of the children of `parent` in its flow that are
    /// not placeholders, when it has any.
    fn rendered_size(&self, parent: Key) -> Option<(f32, f32)> {
        let (mut width, mut height, mut count) = (0.0f32, 0.0f32, 0u32);
        for &child in &self.nodes[parent as usize].children {
            let node = &self.nodes[child as usize];
            let Some(layout) = node.layout else { continue };
            if node.placeholder
                || node.is_layout_root()
                || node.is_overlay()
                || self.layout.displays_none(layout)
                || self.layout.style(layout).position == Position::Absolute
            {
                continue;
            }
            let size = self.layout.unrounded_layout(layout).size;
            width += size.width;
            height += size.height;
            count += 1;
        }
        (count > 0).then(|| {
            (
                (width / count as f32).round(),
                (height / count as f32).round(),
            )
        })
    }
}

/// Whether `dimension` is a length within 5% (and a point) of `value`: a
/// placeholder close to its estimate keeps its size.
fn near(dimension: taffy::Dimension, value: f32) -> bool {
    let raw = dimension.into_raw();
    raw.tag() == taffy::CompactLength::LENGTH_TAG
        && (raw.value() - value).abs() < (value * 0.05).max(1.0)
}
