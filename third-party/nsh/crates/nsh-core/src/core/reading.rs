//! Reading anchors use the final shaped source lines, not recycled node ids.
//! The list keeps the one pin; this module only derives its geometry index.

use super::{Core, Key, Kind, LeafContext, NO_KEY, Node, TextEngine, content_box};
use crate::text_source::{SourceGeometry, SourcePoint, SourcePosition, SourceRow};

struct Seat {
    key: Key,
    y: f32,
    clip: (f32, f32),
}

impl<M: TextEngine> Core<M> {
    /// Rebuilt on source/layout/cell changes. Wheel reports use the resulting
    /// line index and do not walk text nodes or reconstruct line geometry.
    pub(super) fn list_source_geometry(&mut self, key: Key) -> SourceGeometry {
        let list = self.nodes[key as usize].list.as_ref().expect("list");
        // A parent-viewport list contributes its texts to the existing outer
        // list's index; it must not become another reader/scroll owner.
        if list.horizontal || list.inverted || list.parent {
            return SourceGeometry::default();
        }
        let mut seats = Vec::new();
        for (cell, y) in self.source_cells(key) {
            self.source_seats(
                cell,
                y,
                (f32::NEG_INFINITY, f32::INFINITY),
                None,
                &mut seats,
            );
        }
        self.source_geometry(seats)
    }

    fn source_geometry(&mut self, seats: Vec<Seat>) -> SourceGeometry {
        let keys: Vec<_> = seats.iter().map(|seat| seat.key).collect();
        // This is the same cached text layout used by the final mount flush.
        // Taffy's final content box is already available even when a resized
        // cell has not yet queued descendant frame notifications.
        self.flush_texts(&keys, false);
        let mut geometry = SourceGeometry::default();
        for seat in seats {
            let Some(layout) = self.nodes[seat.key as usize].layout else {
                continue;
            };
            let Some(LeafContext::Text(cx)) = self.layout.get_node_context(layout) else {
                continue;
            };
            if let (Some(lines), Some((content, _))) = (&cx.source_geometry, &cx.laid_out) {
                geometry.append(lines, seat.y + content.origin.y.0, seat.clip);
            }
        }
        geometry.finish();
        geometry
    }

    /// A provider exists independently of its virtual rows' materialization.
    /// Traverse only source-live cells, so recycled leftovers cannot retain a source.
    fn source_provider(&self, reader: Key, point: &SourcePoint) -> Option<Key> {
        self.source_cells(reader)
            .into_iter()
            .find_map(|(cell, _)| self.source_provider_in(cell, point))
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

    fn source_provider_in(&self, key: Key, point: &SourcePoint) -> Option<Key> {
        let node = self.source_node(key)?;
        if let Some(list) = &node.list {
            if list
                .source_rows
                .as_ref()
                .is_some_and(|source| source.id == point.id)
            {
                return Some(key);
            }
            return self
                .source_cells(key)
                .into_iter()
                .find_map(|(cell, _)| self.source_provider_in(cell, point));
        }
        node.children
            .iter()
            .find_map(|&child| self.source_provider_in(child, point))
    }

    /// One required cell is derived from the outer reader's existing source pin.
    /// It uses the ordinary window and urgent-binding path, never a second pin.
    pub(super) fn reading_row(&self, key: Key) -> Option<u32> {
        let list = self.nodes[key as usize].list.as_ref()?;
        let reader = if list.parent { list.outer?.view } else { key };
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

    /// Resolve within the addressed logical row. Other mounted rows are not
    /// evidence of this document's beginning or end.
    pub(super) fn reading_position(&mut self, reader: Key, point: &SourcePoint) -> SourcePosition {
        let Some(provider) = self.source_provider(reader, point) else {
            return self.nodes[reader as usize]
                .list
                .as_ref()
                .expect("reader")
                .source_geometry
                .position(point)
                .map_or(SourcePosition::Closed, SourcePosition::Ready);
        };
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
        let Some(cell_layout) = self.nodes.get(cell as usize).and_then(|node| node.layout) else {
            return SourcePosition::Pending;
        };
        let measured = self.rounded_layout(cell_layout).size.height;
        if self.layout.dirty(cell_layout)
            || !list.source_row_matches_layout(index, measured)
            || list
                .spacer
                .is_some_and(|(_, length)| length != list.content_len())
        {
            return SourcePosition::Pending;
        }
        // A newly measured row may still have its parent's old 50pt spacer
        // layout. Fixed heights and actual clipping settle normally once clean.
        let mut ancestor = cell;
        while ancestor != reader {
            let node = &self.nodes[ancestor as usize];
            if node.layout.is_none_or(|layout| self.layout.dirty(layout)) {
                return SourcePosition::Pending;
            }
            ancestor = node.parent;
            if ancestor == NO_KEY {
                return SourcePosition::Closed;
            }
        }
        let mut seats = Vec::new();
        for (cell, y) in self.source_cells(reader) {
            self.source_seats(
                cell,
                y,
                (f32::NEG_INFINITY, f32::INFINITY),
                Some((provider, index)),
                &mut seats,
            );
        }
        self.source_geometry(seats)
            .position(point)
            .map_or(SourcePosition::Closed, SourcePosition::Ready)
    }

    /// Current ready cells in the same natural positions `update_list` uses.
    fn source_cells(&self, key: Key) -> Vec<(Key, f32)> {
        let node = &self.nodes[key as usize];
        let list = node.list.as_ref().expect("list");
        let inset = if list.parent {
            node.layout.map_or(0.0, |layout| {
                content_box(&self.rounded_layout(layout)).origin.y.0
            })
        } else {
            0.0
        };
        let mut rows: Vec<_> = list
            .slots
            .iter()
            .filter_map(|slot| slot.ready().map(|index| (index, slot.cell)))
            .collect();
        rows.sort_unstable_by_key(|&(index, _)| index);
        let blocks = list.blocks();
        let mut out = Vec::with_capacity(rows.len() + 3);
        let header = list.extras[0].cell;
        if header != u32::MAX {
            out.push((header, inset + blocks.header));
        }
        out.extend(
            rows.into_iter()
                .map(|(index, cell)| (cell, inset + list.item_at(index))),
        );
        let empty = list.extras[2].cell;
        if list.count == 0 && empty != u32::MAX {
            out.push((empty, inset + blocks.body));
        }
        let footer = list.extras[1].cell;
        if footer != u32::MAX {
            out.push((footer, inset + blocks.footer));
        }
        out
    }

    fn source_seats(
        &self,
        key: Key,
        y: f32,
        mut clip: (f32, f32),
        target: Option<(Key, u32)>,
        out: &mut Vec<Seat>,
    ) {
        let Some(node) = self.source_node(key) else {
            return;
        };
        let Some(layout) = node.layout else { return };
        let frame = self.rounded_layout(layout);
        let parent_list = node.list.as_ref().is_some_and(|list| list.parent);
        if node.view_style.overflow_hidden || node.scroll.is_some() {
            clip = (clip.0.max(y), clip.1.min(y + frame.size.height));
            if clip.0 >= clip.1 {
                return;
            }
        }
        if let Some(LeafContext::Text(cx)) = self.layout.get_node_context(layout) {
            if target.is_none() && !cx.sources.is_empty() {
                out.push(Seat { key, y, clip });
            }
            // Styled nested texts belong to this flattened text block.
            // Inline view attachments have their own glyph placement rather
            // than a normal child-layout position.
            return;
        }
        if parent_list {
            if let Some((provider, index)) = target
                && provider == key
            {
                let list = node.list.as_ref().expect("parent list");
                let cell = list
                    .slots
                    .iter()
                    .find_map(|slot| (slot.ready() == Some(index)).then_some(slot.cell));
                for (ready, at) in self.source_cells(key) {
                    if Some(ready) == cell {
                        self.source_seats(ready, y + at, clip, None, out);
                    }
                }
            } else {
                for (cell, at) in self.source_cells(key) {
                    self.source_seats(cell, y + at, clip, target, out);
                }
            }
            return;
        }
        for &child in &node.children {
            let child_node = &self.nodes[child as usize];
            if let Some(child_layout) = child_node.layout {
                let child_y = self.rounded_layout(child_layout).location.y;
                self.source_seats(child, y + child_y, clip, target, out);
            }
        }
    }
}
