//! Which list item a selectable view's selection starts and ends in
//! (`onSelectionChange`'s `anchor` and `focus`).
//!
//! A platform reports each end as the view node of its text and the UTF-16
//! offset in it ([`crate::selection::SelectionModel::ends`]). The core knows
//! the tree: the list cells around that text, innermost first, and the row
//! each shows. The runtime names rows of its own lists
//! ([`ListItemKey`]): the end goes by the innermost list the runtime names
//! a row of, and where it is in the copy of that row's item, which the core
//! gets by listing the cell's texts as the platforms list an area's
//! ([`list_texts`]). Rows of lists the runtime does not hold (a Rust
//! component's) go by their index.

use std::{ops::Range, sync::Arc};

use super::{Core, Key, Kind, LeafContext, NO_KEY};
use crate::{
    AttributedText, CellSlot, EventPayload, PayloadValue,
    geometry::{Bounds, Point, Points, point},
    ops::NodeId,
    selection::{
        END_FIELDS, ITEM_FIELDS, ListItemKey, ListedText, SelectionTexts, TextPosition, TextTree,
        copy_offset, list_texts,
    },
    text::TextEngine,
};

/// The core's nodes as the views a backend lists texts from.
struct Nodes<'a, M: TextEngine>(&'a Core<M>);

impl<M: TextEngine> TextTree for Nodes<'_, M> {
    type View = Key;

    fn hidden(&self, &key: &Key) -> bool {
        let node = &self.0.nodes[key as usize];
        node.layout.is_none()
            || node.view_style.hidden
            || node.spare
            || node.hidden_in_text
            || !super::measure::valid(&node.frame)
    }

    fn text(&self, &key: &Key) -> Option<(Arc<AttributedText>, Bounds<Points>)> {
        let node = &self.0.nodes[key as usize];
        if node.kind != Kind::Text {
            return None;
        }
        let Some(LeafContext::Text(cx)) = self.0.layout.get_node_context(node.layout?) else {
            return None;
        };
        Some(match &cx.laid_out {
            Some(laid) => (Arc::clone(&laid.text), laid.content),
            None => (
                Arc::clone(&cx.text),
                Bounds::new(Point::default(), node.frame.size),
            ),
        })
    }

    fn children(&self, &key: &Key, out: &mut Vec<(Key, Bounds<Points>)>) {
        out.extend(
            self.0.nodes[key as usize]
                .children
                .iter()
                .map(|&child| (child, self.0.nodes[child as usize].frame)),
        );
    }

    fn content_offset(&self, &key: &Key) -> (Point<Points>, f32) {
        // The core's offset is in the zoomed content's points.
        self.0.nodes[key as usize]
            .scroll
            .as_deref()
            .map_or((Point::default(), 1.0), |s| {
                let zoom = if s.zoom > 0.0 { s.zoom } else { 1.0 };
                (
                    point(Points(s.offset.0 / zoom), Points(s.offset.1 / zoom)),
                    zoom,
                )
            })
    }
}

/// The texts of one list cell, as a selectable view's backend lists them.
struct CellTexts {
    listed: Vec<ListedText<Key>>,
    ids: Vec<u64>,
    continues: Vec<bool>,
}

impl SelectionTexts for CellTexts {
    fn len(&self) -> usize {
        self.listed.len()
    }

    fn content(&self, i: usize) -> &str {
        &self.listed[i].text.text
    }

    fn copied(&self, i: usize, range: Range<u32>) -> String {
        self.listed[i].text.copied_text(range)
    }

    fn frame(&self, i: usize) -> Bounds<Points> {
        self.listed[i].frame
    }

    // Only copies are made of these texts: nothing hit-tests them.
    fn offset_at(&self, _: usize, _: Point<Points>) -> u32 {
        0
    }

    fn key(&self, i: usize) -> u64 {
        self.ids[i]
    }

    fn continues(&self, i: usize) -> bool {
        self.continues[i]
    }

    fn marker(&self, i: usize) -> Option<&str> {
        self.listed[i].marker.as_deref()
    }
}

impl<M: TextEngine> Core<M> {
    /// Names the ends of a selectable view's `onSelectionChange` payload:
    /// each end a platform reported as a text node and an offset in it
    /// ([`END_FIELDS`]) becomes the key of the list item it is in and the
    /// offset in the copy of that item ([`ITEM_FIELDS`]), or is left out.
    /// `key_of` is what the runtime calls row `index` of list `list`. The
    /// engine calls it for each `onSelectionChange`.
    #[doc(hidden)]
    pub fn name_selection_ends(
        &self,
        payload: &mut EventPayload,
        mut key_of: impl FnMut(NodeId, u32) -> ListItemKey,
    ) {
        let EventPayload::Map(fields) = payload else {
            return;
        };
        let number = |fields: &[(&str, PayloadValue)], key: &str| {
            fields.iter().find_map(|(k, v)| match v {
                PayloadValue::Number(n) if *k == key && *n >= 0.0 => Some(*n),
                _ => None,
            })
        };
        let ends = END_FIELDS.map(|(node, offset)| {
            Some((
                number(fields, node)? as NodeId,
                number(fields, offset)? as u32,
            ))
        });
        fields.retain(|(k, _)| {
            !END_FIELDS
                .iter()
                .any(|(node, offset)| k == node || k == offset)
        });
        for (end, (key, offset)) in ends.into_iter().zip(ITEM_FIELDS) {
            let Some((name, item_offset)) =
                end.and_then(|(node, at)| self.selection_end_item(node, at, &mut key_of))
            else {
                continue;
            };
            fields.push((key, PayloadValue::Str(name)));
            fields.push((offset, PayloadValue::Number(f64::from(item_offset))));
        }
    }

    /// The list item around text node `text` that names a selection's end
    /// at its UTF-16 offset `offset`, and where that is in the copy of the
    /// item. From the innermost list cell out, the first row `key_of` names
    /// (a list the runtime holds) gives the key; one it fails to name
    /// leaves the end out; when no list around is the runtime's, the
    /// innermost row goes by its index. `None` outside a list item, or in a
    /// cell that shows no row.
    fn selection_end_item(
        &self,
        text: NodeId,
        offset: u32,
        key_of: &mut impl FnMut(NodeId, u32) -> ListItemKey,
    ) -> Option<(String, u32)> {
        let mut cell = self.key(text).ok()?;
        let mut innermost = None;
        while cell != NO_KEY {
            let node = &self.nodes[cell as usize];
            let parent = node.parent;
            if let Some(CellSlot::Item(slot)) = node.slot
                && parent != NO_KEY
                && let Some(list) = self.nodes[parent as usize].list.as_deref()
            {
                let row = list.slots.get(slot as usize)?.rendered?;
                match key_of(self.nodes[parent as usize].id, row) {
                    ListItemKey::Named(key) => {
                        return Some((key, self.offset_in_item(cell, text, offset)?));
                    }
                    ListItemKey::Failed => return None,
                    ListItemKey::NotMine => {
                        innermost.get_or_insert((cell, row));
                    }
                }
            }
            cell = parent;
        }
        let (cell, row) = innermost?;
        Some((row.to_string(), self.offset_in_item(cell, text, offset)?))
    }

    /// Where UTF-16 offset `offset` of text node `text` is in the copy of
    /// the list item cell `cell` shows: its texts listed as a selectable
    /// view's backend lists them.
    fn offset_in_item(&self, cell: Key, text: NodeId, offset: u32) -> Option<u32> {
        let listed = list_texts(&Nodes(self), &cell);
        let ids: Vec<u64> = listed
            .iter()
            .map(|t| u64::from(self.nodes[t.view as usize].id))
            .collect();
        let continues = listed
            .iter()
            .map(|t| {
                self.nodes[t.view as usize]
                    .props
                    .as_ref()
                    .is_some_and(|p| p.continues_text)
            })
            .collect();
        let texts = CellTexts {
            listed,
            ids,
            continues,
        };
        let at = texts.ids.iter().position(|&k| k == u64::from(text))?;
        let len = utf16_len(texts.content(at));
        Some(copy_offset(&texts, TextPosition::new(at, offset.min(len))))
    }
}

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}
