//! Reading anchors use the final shaped source lines, not recycled node ids.
//! The list keeps the one pin; this module resolves positions on demand from
//! Core's authoritative `source_texts` and `source_providers` indexes without
//! maintaining a per-list eager geometry cache.

use std::cmp::Ordering;

use super::{Core, Key, Kind, LeafContext, NO_KEY, Node, TextEngine, content_box};
use crate::text_source::{SourceGeometry, SourcePoint, SourcePosition, SourceRow};

struct Seat {
    key: Key,
    y: f32,
    clip: (f32, f32),
}

impl<M: TextEngine> Core<M> {
    /// Finds the first visible source line inside `reader`'s viewport
    /// `[start, end)` to establish a new reading pin.
    ///
    /// Pass `flush: false` outside `commit()` (during `set_scroll_offset`) to
    /// read only the already-committed frames and text geometry submitted to
    /// the platform without queuing mounts or mixing uncommitted layout.
    pub(super) fn first_visible_source(
        &mut self,
        reader: Key,
        start: f32,
        end: f32,
        flush: bool,
    ) -> Option<(SourcePoint, f32)> {
        if self.source_texts.is_empty() || start >= end {
            return None;
        }
        let list = self.nodes[reader as usize].list.as_ref().expect("list");
        if list.horizontal || list.inverted || list.parent {
            return None;
        }
        let committed = !flush;
        let mut seats = Vec::new();
        for &text_key in &self.source_texts {
            if let Some(seat) = self.seat_in_reader(reader, text_key, None, committed) {
                seats.push(seat);
            }
        }
        if seats.is_empty() {
            return None;
        }
        #[cfg(test)]
        {
            self.source_geometry_walks += 1;
        }
        self.source_geometry(seats, None, flush)
            .first_visible(start, end)
    }

    fn source_geometry(
        &mut self,
        seats: Vec<Seat>,
        point: Option<&SourcePoint>,
        flush: bool,
    ) -> SourceGeometry {
        if flush {
            let keys: Vec<_> = seats.iter().map(|seat| seat.key).collect();
            if let Some(point) = point {
                for &key in &keys {
                    let node = &self.nodes[key as usize];
                    let matches_doc = node
                        .layout
                        .and_then(|layout| self.layout.get_node_context(layout))
                        .is_some_and(|cx| {
                            matches!(cx, LeafContext::Text(cx) if cx.sources.has_document(&point.id))
                        });
                    // Reflow can move the anchored glyph outside the old native
                    // viewport. Its text must be realized before deciding the
                    // source disappeared, just as a focus command realizes its target.
                    if !node.created && matches_doc {
                        self.uncull(key);
                    }
                }
            }
            // This is the same cached text layout used by the final mount flush.
            // Taffy's final content box is already available even when a resized
            // cell has not yet queued descendant frame notifications.
            self.flush_texts(&keys, false);
        }
        let mut geometry = SourceGeometry::default();
        for seat in seats {
            let Some(layout) = self.nodes[seat.key as usize].layout else {
                continue;
            };
            let Some(LeafContext::Text(cx)) = self.layout.get_node_context(layout) else {
                continue;
            };
            if let (Some(lines), Some(laid)) = (&cx.source_geometry, &cx.laid_out) {
                geometry.append(lines, seat.y + laid.content.origin.y.0, seat.clip);
            }
        }
        geometry.finish();
        geometry
    }

    /// A provider exists independently of its virtual rows' materialization.
    /// Walk up from registered providers and break ties in reader tree order.
    fn source_provider(&self, reader: Key, point: &SourcePoint) -> Option<Key> {
        let mut best: Option<Key> = None;
        for &provider in &self.source_providers {
            let Some(list) = self
                .nodes
                .get(provider as usize)
                .and_then(|n| n.list.as_ref())
            else {
                continue;
            };
            if list
                .source_rows
                .as_ref()
                .is_some_and(|source| source.id == point.id)
                && self.node_in_reader(reader, provider)
            {
                best = match best {
                    None => Some(provider),
                    Some(prev)
                        if self.reader_tree_order_cmp(reader, provider, prev) == Ordering::Less =>
                    {
                        Some(provider)
                    }
                    Some(prev) => Some(prev),
                };
            }
        }
        best
    }

    fn reader_tree_order_cmp(&self, reader: Key, a: Key, b: Key) -> Ordering {
        if a == b {
            return Ordering::Equal;
        }
        let path_from_reader = |mut k: Key| -> Vec<Key> {
            let mut path = Vec::with_capacity(8);
            while k != NO_KEY {
                path.push(k);
                if k == reader {
                    break;
                }
                k = self.nodes[k as usize].parent;
            }
            path.reverse();
            path
        };
        let pa = path_from_reader(a);
        let pb = path_from_reader(b);
        let common = pa.len().min(pb.len());
        for i in 1..common {
            if pa[i] != pb[i] {
                let parent = pa[i - 1];
                let pnode = &self.nodes[parent as usize];
                if let Some(list) = pnode.list.as_ref() {
                    let rank = |cell: Key| -> (u8, u32) {
                        if list.extras[0].cell == cell {
                            return (0, 0);
                        }
                        if let Some(index) = list
                            .slots
                            .iter()
                            .find(|s| s.cell == cell)
                            .and_then(|s| s.ready())
                        {
                            return (1, index);
                        }
                        if list.count == 0 && list.extras[2].cell == cell {
                            return (2, 0);
                        }
                        if list.extras[1].cell == cell {
                            return (3, 0);
                        }
                        (4, cell)
                    };
                    return rank(pa[i]).cmp(&rank(pb[i]));
                }
                let pos = |child: Key| {
                    pnode
                        .children
                        .iter()
                        .position(|&c| c == child)
                        .unwrap_or(usize::MAX)
                };
                return pos(pa[i]).cmp(&pos(pb[i]));
            }
        }
        pa.len().cmp(&pb.len())
    }

    /// Source ownership does not require a provider's layout to be ready.
    fn source_node(&self, key: Key) -> Option<&Node> {
        let node = self.nodes.get(key as usize)?;
        if node.kind.is_root() || self.displays_none(key) {
            return None;
        }
        let parent_list = node.list.as_ref().is_some_and(|list| list.parent);
        if let Some(scroll) = &node.scroll
            && !parent_list
            && !scroll.horizontal
            && (node.kind == Kind::List
                || scroll.behavior.enabled
                || scroll.offset.1 != 0.0
                || !scroll.pending.is_empty())
        {
            // An independent vertical reader's offsets are not reflow of
            // this reader. Disabled wrapped code stays in its source subtree.
            return None;
        }
        Some(node)
    }

    fn is_text_leaf(&self, node: &Node) -> bool {
        node.layout
            .and_then(|layout| self.layout.get_node_context(layout))
            .is_some_and(|cx| matches!(cx, LeafContext::Text(_)))
    }

    /// Whether `cell` is a currently active source cell of `list_key`,
    /// returning its natural Y offset inside `list_key` when `compute_y` is
    /// requested (or `0.0` for membership checks without requiring layout).
    fn list_cell_y(
        &self,
        list_key: Key,
        cell: Key,
        required_index: Option<u32>,
        compute_y: bool,
    ) -> Option<f32> {
        let node = self.nodes.get(list_key as usize)?;
        let list = node.list.as_ref()?;
        let inset = if compute_y && list.parent {
            node.layout.map_or(0.0, |layout| {
                content_box(&self.rounded_layout(layout)).origin.y.0
            })
        } else {
            0.0
        };
        let cross_y = |index: Option<u32>| -> f32 {
            if !compute_y {
                return 0.0;
            }
            if !list.horizontal {
                return inset
                    + match index {
                        Some(i) => list.item_at(i),
                        None => 0.0,
                    };
            }
            let cross = node.layout.map_or(0.0, |layout| {
                content_box(&self.rounded_layout(layout)).size.height.0
            });
            let y = match index {
                Some(i) => list.column(cross, list.column_of(i), None).0,
                None => list.full_width(cross).0,
            };
            inset + y
        };
        if let Some(index) = required_index {
            let matches = list
                .slots
                .iter()
                .any(|slot| slot.cell == cell && slot.ready() == Some(index));
            return matches.then(|| cross_y(Some(index)));
        }
        if list.extras[0].cell == cell {
            return Some(if compute_y && !list.horizontal {
                inset + list.blocks().header
            } else {
                cross_y(None)
            });
        }
        if list.count == 0 && list.extras[2].cell == cell {
            return Some(if compute_y && !list.horizontal {
                inset + list.blocks().body
            } else {
                cross_y(None)
            });
        }
        if list.extras[1].cell == cell {
            return Some(if compute_y && !list.horizontal {
                inset + list.blocks().footer
            } else {
                cross_y(None)
            });
        }
        let index = list
            .slots
            .iter()
            .find(|slot| slot.cell == cell)
            .and_then(|slot| slot.ready())?;
        Some(cross_y(Some(index)))
    }

    /// Whether `key` belongs to `reader`'s source subtree (without requiring
    /// layout readiness).
    fn node_in_reader(&self, reader: Key, key: Key) -> bool {
        if key == reader {
            return !self.displays_none(reader);
        }
        let mut curr = key;
        loop {
            if self.source_node(curr).is_none() {
                return false;
            }
            let parent = self.nodes[curr as usize].parent;
            if parent == NO_KEY {
                return false;
            }
            if parent == reader {
                return self.list_cell_y(reader, curr, None, false).is_some();
            }
            let Some(parent_node) = self.source_node(parent) else {
                return false;
            };
            if self.is_text_leaf(parent_node) {
                return false;
            }
            if parent_node.list.is_some() && self.list_cell_y(parent, curr, None, false).is_none() {
                return false;
            }
            curr = parent;
        }
    }

    /// Computes `key`'s seat (content-space Y and clip interval) within
    /// `reader` by walking only its ancestor chain.
    ///
    /// When `committed` is `true` (pre-commit `set_scroll_offset`), reads the
    /// committed `node.frame` coordinates last submitted to the platform so
    /// uncommitted `Splice` / `ListContent` mutations never skew capture.
    fn seat_in_reader(
        &self,
        reader: Key,
        key: Key,
        target: Option<(Key, u32)>,
        committed: bool,
    ) -> Option<Seat> {
        let leaf = self.source_node(key)?;
        if committed {
            if !leaf.created
                || !leaf.frame.origin.y.0.is_finite()
                || !leaf.frame.size.height.0.is_finite()
            {
                return None;
            }
        } else {
            leaf.layout?;
        }
        let mut path: Vec<(Key, f32)> = Vec::with_capacity(12);
        let mut curr = key;
        let mut hit_target = target.is_none();
        loop {
            let curr_node = &self.nodes[curr as usize];
            let parent = curr_node.parent;
            if parent == NO_KEY {
                return None;
            }
            if parent == reader {
                let dy = if committed {
                    if !curr_node.created
                        || curr_node.spare
                        || curr_node.left_behind
                        || !curr_node.frame.origin.y.0.is_finite()
                        || !curr_node.frame.size.height.0.is_finite()
                    {
                        return None;
                    }
                    curr_node.frame.origin.y.0
                } else {
                    let required = target.and_then(|(p, i)| (p == parent).then_some(i));
                    if required.is_some() {
                        hit_target = true;
                    }
                    self.list_cell_y(reader, curr, required, true)?
                };
                path.push((curr, dy));
                break;
            }
            let parent_node = self.source_node(parent)?;
            if self.is_text_leaf(parent_node) {
                return None;
            }
            let dy = if committed {
                if !curr_node.created
                    || !curr_node.frame.origin.y.0.is_finite()
                    || !curr_node.frame.size.height.0.is_finite()
                {
                    return None;
                }
                if parent_node.list.as_ref().is_some_and(|list| list.parent)
                    && (curr_node.spare || curr_node.left_behind)
                {
                    return None;
                }
                curr_node.frame.origin.y.0
            } else if parent_node.list.as_ref().is_some_and(|list| list.parent) {
                let required = target.and_then(|(p, i)| (p == parent).then_some(i));
                if required.is_some() {
                    hit_target = true;
                }
                self.list_cell_y(parent, curr, required, true)?
            } else {
                let curr_layout = curr_node.layout?;
                self.rounded_layout(curr_layout).location.y
            };
            path.push((curr, dy));
            curr = parent;
        }
        if !hit_target {
            return None;
        }
        let mut y = 0.0f32;
        let mut clip = (f32::NEG_INFINITY, f32::INFINITY);
        for &(step, dy) in path.iter().rev() {
            y += dy;
            let node = &self.nodes[step as usize];
            if node.view_style.overflow_hidden || node.scroll.is_some() {
                let height = if committed {
                    let h = node.frame.size.height.0;
                    if !h.is_finite() {
                        return None;
                    }
                    h
                } else {
                    self.rounded_layout(node.layout?).size.height
                };
                clip = (clip.0.max(y), clip.1.min(y + height));
                if clip.0 >= clip.1 {
                    return None;
                }
            }
        }
        Some(Seat { key, y, clip })
    }

    /// Finds the enclosing vertical reader list (walking past `parent` lists
    /// and disabled scroll wrappers, stopping at independent vertical scroll
    /// containers or `display: none`).
    pub(super) fn enclosing_reader(&self, mut key: Key) -> Option<Key> {
        while key != NO_KEY {
            let node = self.nodes.get(key as usize)?;
            if let Some(list) = node.list.as_ref()
                && !list.parent
                && !list.horizontal
                && !list.inverted
            {
                return (!self.displays_none(key)).then_some(key);
            }
            self.source_node(key)?;
            key = node.parent;
        }
        None
    }

    /// Marks the enclosing vertical reader list dirty so it re-evaluates its
    /// reading pin in this commit. Returns `true` if a reader was marked.
    pub(super) fn mark_enclosing_reader_dirty(&mut self, key: Key, only_if_active: bool) -> bool {
        let Some(reader) = self.enclosing_reader(key) else {
            return false;
        };
        let list = self.nodes[reader as usize].list.as_mut().expect("reader");
        if only_if_active
            && list.reading_point().is_none()
            && list.wants_reading_pin(false, list.content_len()).is_none()
        {
            return false;
        }
        list.dirty = true;
        true
    }

    /// One required cell is derived from the outer reader's existing source pin.
    /// It uses the ordinary window and urgent-binding path, never a second pin.
    pub(super) fn reading_row(&self, key: Key) -> Option<u32> {
        let node = &self.nodes[key as usize];
        let list = node.list.as_ref()?;
        let reader = if list.parent {
            self.enclosing_reader(node.parent)?
        } else {
            key
        };
        let point = self.nodes[reader as usize].list.as_ref()?.reading_point()?;
        let provider = self.source_provider(reader, point)?;
        if provider == key {
            return match list.source_rows.as_ref()?.row(point.byte) {
                SourceRow::Row(index) if index < list.count => Some(index),
                _ => None,
            };
        }
        // Keep the provider's ancestor cells alive while the inner row binds.
        let mut child = provider;
        loop {
            let parent = self.nodes[child as usize].parent;
            if parent == NO_KEY {
                return None;
            }
            if parent == key {
                return list
                    .slots
                    .iter()
                    .find(|slot| slot.cell == child)
                    .and_then(|slot| slot.index);
            }
            child = parent;
        }
    }

    /// Resolve within the addressed logical row (when backed by a provider) or
    /// directly via the ancestor chain of sourced text blocks for `point.id`.
    pub(super) fn reading_position(&mut self, reader: Key, point: &SourcePoint) -> SourcePosition {
        if self.source_texts.is_empty() && self.source_providers.is_empty() {
            return SourcePosition::Closed;
        }
        if let Some(provider) = self.source_provider(reader, point) {
            let node = &self.nodes[provider as usize];
            let list = node.list.as_ref().expect("source provider");
            let source = list.source_rows.as_ref().expect("source rows");
            let index = match source.row(point.byte) {
                SourceRow::Pending => return SourcePosition::Pending,
                SourceRow::Closed => return SourcePosition::Closed,
                SourceRow::Row(index) => index,
            };
            let Some(cell) = list
                .slots
                .iter()
                .find_map(|slot| (slot.ready() == Some(index)).then_some(slot.cell))
            else {
                return SourcePosition::Pending;
            };
            let Some(cell_layout) = self.nodes.get(cell as usize).and_then(|node| node.layout)
            else {
                return SourcePosition::Pending;
            };
            let measured_size = self.rounded_layout(cell_layout).size;
            let measured = if list.horizontal {
                measured_size.width
            } else {
                measured_size.height
            };
            if self.layout.dirty(cell_layout)
                || !list.source_row_matches_layout(index, measured)
                || list
                    .spacer
                    .is_some_and(|(_, length)| length != list.content_len())
            {
                return SourcePosition::Pending;
            }
            // A newly measured row may still have its parent's old spacer layout.
            // An unstyled holder gets its frame from the child laid out in its place.
            let mut ancestor = cell;
            while ancestor != reader {
                let node = &self.nodes[ancestor as usize];
                if node
                    .layout
                    .is_none_or(|layout| self.layout.dirty(self.layout.laid_out(layout)))
                {
                    return SourcePosition::Pending;
                }
                ancestor = node.parent;
                if ancestor == NO_KEY {
                    return SourcePosition::Closed;
                }
            }
            if self
                .seat_in_reader(reader, cell, Some((provider, index)), false)
                .is_none()
            {
                return SourcePosition::Closed;
            }
            let seats = self.document_seats(reader, point, Some((provider, index)));
            if seats.is_empty() {
                return SourcePosition::Closed;
            }
            return self
                .source_geometry(seats, Some(point), true)
                .position(point)
                .map_or(SourcePosition::Closed, SourcePosition::Ready);
        }

        let seats = self.document_seats(reader, point, None);
        if seats.is_empty() {
            return SourcePosition::Closed;
        }
        self.source_geometry(seats, Some(point), true)
            .position(point)
            .map_or(SourcePosition::Closed, SourcePosition::Ready)
    }

    /// Locates all sourced text blocks carrying `point.id` inside `reader`
    /// (preserving syntax-gap forward projection and tail fallback in
    /// `SourceGeometry::position`).
    fn document_seats(
        &self,
        reader: Key,
        point: &SourcePoint,
        target: Option<(Key, u32)>,
    ) -> Vec<Seat> {
        let mut seats = Vec::new();
        for &text_key in &self.source_texts {
            let Some(node) = self.nodes.get(text_key as usize) else {
                continue;
            };
            let matches_doc = node
                .layout
                .and_then(|layout| self.layout.get_node_context(layout))
                .is_some_and(
                    |cx| matches!(cx, LeafContext::Text(cx) if cx.sources.has_document(&point.id)),
                );
            if matches_doc && let Some(seat) = self.seat_in_reader(reader, text_key, target, false)
            {
                seats.push(seat);
            }
        }
        seats
    }
}
