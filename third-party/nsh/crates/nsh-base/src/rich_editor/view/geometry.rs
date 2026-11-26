//! Where the document is on screen: the blocks' frames as their views
//! report them, each textblock's laid-out [`TextGeometry`] and lines
//! (`Text::on_text_layout`), and the map between a textblock's document
//! positions and its rendered text offsets (atoms and widgets are one
//! character there; synthetic span-padding spacers are hidden by
//! `TextGeometry`). From them: the caret's box at a position, the boxes
//! of a range, and the position at a point, answered directly by the
//! platform's [`TextEngine`](nsh_core::TextEngine) without re-measuring.
//! Document positions and visual places stay apart: a position at a line
//! wrap is two places, which the selection's affinity tells apart.

use std::collections::HashMap;

use nsh_core::{TextGeometry, TextLine, TextPosition, prelude::*};

use crate::rich_editor::state::Affinity;

/// The block id of the document itself (its children's parent).
pub(crate) const DOC: u64 = 0;

/// The id of the slot a node view with an editable content slot renders
/// its content in (a box measured in its block's box).
pub(crate) fn slot_id(id: u64) -> u64 {
    id | (1 << 62)
}

/// A stretch of a textblock's content and of its rendered text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Run {
    /// Its start in the textblock's content (from its first position).
    pub(crate) doc: usize,
    /// Its length in the document (0 for a widget).
    pub(crate) doc_len: usize,
    /// Its start in the rendered text (UTF-16 units).
    pub(crate) text: u32,
    /// Its length in the rendered text.
    pub(crate) text_len: u32,
    /// For a widget: which side of its position it sticks to.
    pub(crate) side: i32,
}

/// A textblock's content as its text renders it.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct InlineMap {
    pub(crate) runs: Vec<Run>,
    /// The content's size in the document.
    pub(crate) size: usize,
    /// The rendered text's length.
    pub(crate) len: u32,
}

impl InlineMap {
    /// The text offset of content offset `d`.
    pub(crate) fn to_text(&self, d: usize) -> u32 {
        let mut t = 0;
        for run in &self.runs {
            if run.doc_len == 0 {
                if run.doc < d || (run.doc == d && run.side < 0) {
                    t = run.text + run.text_len;
                    continue;
                }
                break;
            }
            if d >= run.doc + run.doc_len {
                t = run.text + run.text_len;
                continue;
            }
            if d >= run.doc {
                // Atoms are one unit either way: inside a text run the
                // units match.
                return run.text + (d - run.doc).min(run.text_len as usize) as u32;
            }
            break;
        }
        t
    }

    /// The content offset of text offset `t`.
    pub(crate) fn to_doc(&self, t: u32) -> usize {
        for run in &self.runs {
            if t < run.text + run.text_len {
                if t < run.text {
                    return run.doc;
                }
                return if run.doc_len == 0 {
                    run.doc
                } else if run.text_len as usize != run.doc_len {
                    // A leaf drawn as text (a mention): the nearer side, the
                    // caret never stands inside it.
                    run.doc + usize::from(2 * (t - run.text) >= run.text_len) * run.doc_len
                } else {
                    run.doc + ((t - run.text) as usize).min(run.doc_len)
                };
            }
        }
        self.size
    }
}

/// A textblock's place on screen.
#[derive(Debug, Clone, Default)]
pub(crate) struct TextGeo {
    /// The textblock's first content position in the document.
    pub(crate) start: usize,
    pub(crate) map: InlineMap,
    /// The lines of its text, in the text's box (content offsets).
    pub(crate) lines: Vec<TextLine>,
    /// The text's frame in its block's box.
    pub(crate) frame: Bounds<Points>,
    /// The box the frame is in (the block's own, else a node view's
    /// content slot).
    pub(crate) owner: Option<u64>,
    /// The text engine's final layout of it (`Text::on_text_layout`),
    /// answering hit testing, caret edges and range boxes directly.
    pub(crate) geometry: Option<TextGeometry>,
    pub(crate) laid_len: Option<u32>,
}

/// The geometry of a rendered document.
#[derive(Default)]
pub(crate) struct Geometry {
    /// Each block's frame in its parent's box, and its parent (a node view's
    /// content slot: its block, measured in the block's box); `None` for a
    /// frame in the content box.
    pub(crate) frames: HashMap<u64, (Option<u64>, Bounds<Points>)>,
    /// Where a block's children start in its box, when they sit in a
    /// holder that is not the block's own origin (a task item's content,
    /// after its checkbox): their frames are in the holder, not the block.
    pub(crate) insets: HashMap<u64, Point<Points>>,
    /// Horizontal scroll offset and visible width of each independently scrolling grid.
    pub(crate) table_scroll: HashMap<u64, (Points, Points)>,
    pub(crate) table_scroll_handles: HashMap<u64, ElementRef>,
    /// The textblocks, by block id.
    pub(crate) texts: HashMap<u64, TextGeo>,
    /// Textblock ids ordered by `TextGeo::start`.
    pub(crate) text_order: Vec<(usize, u64)>,
    /// The atoms and node views edited as units, by block id: their
    /// position.
    pub(crate) atoms: HashMap<u64, usize>,
}

fn to_text_affinity(affinity: Affinity) -> nsh_core::Affinity {
    match affinity {
        Affinity::Upstream => nsh_core::Affinity::Upstream,
        Affinity::Downstream => nsh_core::Affinity::Downstream,
    }
}

fn from_text_affinity(affinity: nsh_core::Affinity) -> Affinity {
    match affinity {
        nsh_core::Affinity::Upstream => Affinity::Upstream,
        nsh_core::Affinity::Downstream => Affinity::Downstream,
    }
}

/// The caret's height in the font's ascender and descender: about one em
/// for common fonts, whose ascender and descender span some 1.2 em.
const CARET_EM: f32 = 0.85;

/// A place a point lands on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Hit {
    /// A position in a textblock, with the side of a wrap it showed on.
    Text(usize, Affinity),
    /// An atom block (its position).
    Node(usize),
}

impl Geometry {
    pub(crate) fn table_viewport(&self, id: u64) -> Option<Bounds<Points>> {
        let (offset, width) = self.table_scroll.get(&id)?;
        let original = self.origin(id)?;
        let (_, grid) = self.frames.get(&id)?;
        Some(Bounds::new(
            Point::new(original.x + *offset, original.y),
            Size::new(*width, grid.size.height),
        ))
    }

    /// Whether the content point `at` is in a block's box before where its
    /// children start: on a task item's checkbox, or under it.
    pub(crate) fn before_holder(&self, at: Point<Points>) -> bool {
        self.insets.iter().any(|(id, inset)| {
            let (Some(origin), Some((_, frame))) = (self.origin(*id), self.frames.get(id)) else {
                return false;
            };
            at.x >= origin.x
                && at.x < origin.x + inset.x
                && at.y >= origin.y
                && at.y < origin.y + frame.size.height
        })
    }

    /// Whether the textblock at `start` with document content size `size`
    /// has already laid out its current text.
    pub(crate) fn text_current(&self, start: usize, size: usize) -> bool {
        self.texts.values().any(|g| {
            g.start == start
                && g.owner.is_some()
                && g.map.size == size
                && g.laid_len == Some(g.map.len)
        })
    }

    /// Block `id`'s top left in the content box.
    pub(crate) fn origin(&self, id: u64) -> Option<Point<Points>> {
        let mut at = Point::default();
        let mut id = Some(id);
        let mut guard = 0;
        while let Some(current) = id {
            if current == DOC {
                return Some(at);
            }
            let (parent, frame) = self.frames.get(&current)?;
            at.x += frame.origin.x;
            at.y += frame.origin.y;
            id = match parent {
                Some(p) => {
                    // A slot is measured in its block's box, its holder's
                    // offset included.
                    if current != slot_id(*p)
                        && let Some(inset) = self.insets.get(p)
                    {
                        at.x += inset.x;
                        at.y += inset.y;
                    }
                    Some(*p)
                }
                None => return Some(at),
            };
            guard += 1;
            if guard > 256 {
                return None;
            }
        }
        Some(at)
    }

    /// Textblock `id`'s text box in the content box.
    fn text_box(&self, id: u64) -> Option<(Point<Points>, &TextGeo)> {
        let geo = self.texts.get(&id)?;
        let origin = self.origin(geo.owner.unwrap_or(id))?;
        Some((
            Point::new(origin.x + geo.frame.origin.x, origin.y + geo.frame.origin.y),
            geo,
        ))
    }

    /// The textblock holding position `pos` (its content's range).
    pub(crate) fn text_at(&self, pos: usize) -> Option<u64> {
        if self.text_order.len() != self.texts.len() {
            return self
                .texts
                .iter()
                .find(|(_, g)| pos >= g.start && pos <= g.start + g.map.size)
                .map(|(id, _)| *id);
        }
        let idx = self.text_order.partition_point(|&(start, _)| start <= pos);
        let &(_, id) = self.text_order.get(idx.checked_sub(1)?)?;
        let g = self.texts.get(&id)?;
        (pos >= g.start && pos <= g.start + g.map.size).then_some(id)
    }

    /// The textblock ids whose content overlaps `from..=to`, in document order.
    pub(crate) fn text_ids_in(&self, from: usize, to: usize) -> Vec<u64> {
        if self.text_order.len() != self.texts.len() {
            let mut ids: Vec<(&u64, &TextGeo)> = self
                .texts
                .iter()
                .filter(|(_, g)| g.start + g.map.size >= from && g.start <= to)
                .collect();
            crate::sort::sort_by_key(&mut ids, |(_, g)| g.start);
            return ids.into_iter().map(|(id, _)| *id).collect();
        }
        let first = self
            .text_order
            .partition_point(|&(start, _)| start < from)
            .saturating_sub(1);
        let end_idx = self.text_order.partition_point(|&(start, _)| start <= to);
        self.text_order[first.min(end_idx)..end_idx]
            .iter()
            .filter_map(|&(_, id)| {
                let g = self.texts.get(&id)?;
                (g.start + g.map.size >= from && g.start <= to).then_some(id)
            })
            .collect()
    }

    /// The content UTF-16 offset for document position `pos` in `geo`.
    fn text_offset(geo: &TextGeo, pos: usize) -> u32 {
        if geo.map.size == 0 {
            0
        } else {
            geo.map.to_text(pos - geo.start)
        }
    }

    /// The caret's box at `pos`: as high as its line, without width.
    pub(crate) fn caret_rect(&self, pos: usize, affinity: Affinity) -> Option<Bounds<Points>> {
        let id = self.text_at(pos)?;
        let (origin, geo) = self.text_box(id)?;
        let t = Self::text_offset(geo, pos);
        let local = geo
            .geometry
            .as_ref()
            .and_then(|g| g.caret_rect(TextPosition::new(t, to_text_affinity(affinity))))
            .unwrap_or_else(|| fallback_caret_rect(geo, t, affinity));
        Some(Bounds::new(origin + local.origin, local.size))
    }

    /// The box of the inline leaf at `pos` (content box): from the text
    /// engine's range box for its single position.
    pub(crate) fn inline_rect(&self, pos: usize) -> Option<Bounds<Points>> {
        self.range_rects(pos, pos + 1)
            .into_iter()
            .reduce(|a, b| a.union(&b))
    }

    /// The drawn caret at `pos`: about the font's em tall (the ascender
    /// and descender less their own gap, as gpui-kit's input draws 0.85 of
    /// a normal line), centred in the line, rather than the whole line box
    /// [`Self::caret_rect`] gives.
    pub(crate) fn caret_glyph_rect(
        &self,
        pos: usize,
        affinity: Affinity,
    ) -> Option<Bounds<Points>> {
        let b = self.caret_rect(pos, affinity)?;
        let id = self.text_at(pos)?;
        let (_, geo) = self.text_box(id)?;
        let t = Self::text_offset(geo, pos);
        let Some(line) = line_of(&geo.lines, t, affinity).map(|i| &geo.lines[i]) else {
            return Some(b);
        };
        let glyphs = (line.ascender + line.descender) * CARET_EM;
        if glyphs <= px(0.0) || glyphs >= b.size.height {
            return Some(b);
        }
        let top = b.origin.y + (b.size.height - glyphs) * 0.5;
        Some(Bounds::new(
            Point::new(b.origin.x, top),
            Size::new(px(0.0), glyphs),
        ))
    }

    /// The boxes covering `from..to`, one per line of each textblock it
    /// crosses (through a line's end where it goes on).
    pub(crate) fn range_rects(&self, from: usize, to: usize) -> Vec<Bounds<Points>> {
        let mut out = Vec::new();
        for id in self.text_ids_in(from, to) {
            let Some((origin, _)) = self.text_box(id) else {
                continue;
            };
            out.extend(
                self.text_range_rects(id, from, to)
                    .into_iter()
                    .map(|b| Bounds::new(origin + b.origin, b.size)),
            );
        }
        out
    }

    /// The boxes of `from..to` in textblock `id`, in its text's box: one
    /// per line it crosses (through a line's end where it goes on), none
    /// when the range misses the block.
    pub(crate) fn text_range_rects(&self, id: u64, from: usize, to: usize) -> Vec<Bounds<Points>> {
        let mut out = Vec::new();
        let Some(geo) = self.texts.get(&id) else {
            return out;
        };
        let (start, end) = (geo.start, geo.start + geo.map.size);
        if end < from || start > to {
            return out;
        }
        let through = to > end;
        if geo.lines.is_empty() {
            if from <= start && through {
                out.push(Bounds::new(
                    Point::default(),
                    Size::new(px(4.0), geo.frame.size.height),
                ));
            }
            return out;
        }
        if geo.map.size == 0 {
            if from <= start && through {
                let line = &geo.lines[0];
                out.push(Bounds::new(
                    Point::new(line.x, line.y),
                    Size::new(px(4.0), line.height),
                ));
            }
            return out;
        }
        let a = geo.map.to_text(from.max(start) - start);
        let b = geo.map.to_text(to.min(end) - start);
        if a < b {
            if let Some(g) = &geo.geometry {
                out = g.range_rects(a..b);
            } else {
                fallback_range_rects(&geo.lines, a..b, &mut out);
            }
            if through {
                if let Some(last) = out.last_mut() {
                    last.size.width += px(4.0);
                } else if let Some(line) = geo.lines.last() {
                    out.push(Bounds::new(
                        Point::new(line.x + line.width, line.y),
                        Size::new(px(4.0), line.height),
                    ));
                }
            }
        } else if through {
            let caret = geo
                .geometry
                .as_ref()
                .and_then(|g| g.caret_rect(TextPosition::new(b, nsh_core::Affinity::Downstream)))
                .unwrap_or_else(|| fallback_caret_rect(geo, b, Affinity::Downstream));
            out.push(Bounds::new(
                caret.origin,
                Size::new(px(4.0), caret.size.height),
            ));
        }
        out
    }

    /// The place at `p` (content box): an atom it is on, else the nearest
    /// textblock's nearest position.
    pub(crate) fn hit(&self, p: Point<Points>) -> Option<Hit> {
        self.hit_in(p, None)
    }

    /// The place at `p` among the atoms and textblocks in `range` (all
    /// without one): a table cell's, which its neighbors beside it must
    /// not take a press from.
    pub(crate) fn hit_in(&self, p: Point<Points>, range: Option<(usize, usize)>) -> Option<Hit> {
        let within = |pos: usize| range.is_none_or(|(from, to)| pos >= from && pos < to);
        for (id, pos) in &self.atoms {
            if within(*pos)
                && let (Some(origin), Some((_, frame))) = (self.origin(*id), self.frames.get(id))
            {
                let b = Bounds::new(origin, frame.size);
                if p.x >= b.origin.x
                    && p.x < b.origin.x + b.size.width
                    && p.y >= b.origin.y
                    && p.y < b.origin.y + b.size.height
                {
                    return Some(Hit::Node(*pos));
                }
            }
        }
        // The textblock nearest vertically (then horizontally).
        let mut best: Option<(f32, f32, u64)> = None;
        for (id, text) in &self.texts {
            if !within(text.start) {
                continue;
            }
            let Some((origin, geo)) = self.text_box(*id) else {
                continue;
            };
            let (top, bottom) = match (geo.lines.first(), geo.lines.last()) {
                (Some(a), Some(b)) => (origin.y + a.y, origin.y + b.y + b.height),
                _ => (origin.y, origin.y + geo.frame.size.height.max(px(1.0))),
            };
            let dy = if p.y < top {
                (top - p.y).0
            } else if p.y >= bottom {
                (p.y - bottom).0 + 0.001
            } else {
                0.0
            };
            let (left, right) = (origin.x, origin.x + geo.frame.size.width);
            let dx = if p.x < left {
                (left - p.x).0
            } else if p.x > right {
                (p.x - right).0
            } else {
                0.0
            };
            if best.is_none_or(|(by, bx, _)| dy < by || (dy == by && dx < bx)) {
                best = Some((dy, dx, *id));
            }
        }
        let (_, _, id) = best?;
        let (origin, geo) = self.text_box(id)?;
        let local = Point::new(p.x - origin.x, p.y - origin.y);
        if geo.lines.is_empty() {
            return Some(Hit::Text(geo.start, Affinity::Downstream));
        }
        if let Some(g) = &geo.geometry {
            let hit = g.hit_test(local);
            return Some(Hit::Text(
                geo.start + geo.map.to_doc(hit.offset),
                from_text_affinity(hit.affinity),
            ));
        }
        let (offset, affinity) = fallback_hit(&geo.lines, local);
        Some(Hit::Text(geo.start + geo.map.to_doc(offset), affinity))
    }

    /// The line `pos` shows on in its textblock, and how many lines the
    /// textblock has.
    pub(crate) fn line_index(&self, pos: usize, affinity: Affinity) -> Option<(usize, usize)> {
        let id = self.text_at(pos)?;
        let geo = self.texts.get(&id)?;
        let t = Self::text_offset(geo, pos);
        Some((line_of(&geo.lines, t, affinity)?, geo.lines.len()))
    }

    /// The start or end of the line `pos` shows on.
    pub(crate) fn line_edge(&self, pos: usize, affinity: Affinity, end: bool) -> Option<usize> {
        let id = self.text_at(pos)?;
        let geo = self.texts.get(&id)?;
        let t = Self::text_offset(geo, pos);
        let line = &geo.lines[line_of(&geo.lines, t, affinity)?];
        let edge = if end {
            // A wrapped line's end is the next one's start: before the
            // space it broke at.
            let text_end = line.start + line.text.encode_utf16().count() as u32;
            let trimmed = line.text.trim_end_matches(['\n', ' ']);
            if line.end < geo.map.len && trimmed.len() < line.text.len() {
                line.start + trimmed.encode_utf16().count() as u32
            } else {
                text_end.min(line.end)
            }
        } else {
            line.start
        };
        Some(geo.start + geo.map.to_doc(edge))
    }
}

/// Linear fallback caret box when a textblock has lines but no `TextGeometry`.
fn fallback_caret_rect(geo: &TextGeo, offset: u32, affinity: Affinity) -> Bounds<Points> {
    match line_of(&geo.lines, offset, affinity) {
        Some(i) => {
            let line = &geo.lines[i];
            Bounds::new(
                Point::new(fallback_x(line, offset), line.y),
                Size::new(px(0.0), line.height),
            )
        }
        None => Bounds::new(
            Point::default(),
            Size::new(px(0.0), geo.frame.size.height.max(px(1.0))),
        ),
    }
}

/// Linear fallback x on `line` for content offset `o`.
fn fallback_x(line: &TextLine, o: u32) -> Points {
    let count = line.end.saturating_sub(line.start);
    if count == 0 {
        return line.x;
    }
    let done = o.clamp(line.start, line.end) - line.start;
    line.x + line.width * (done as f32 / count as f32)
}

/// Linear fallback range boxes when a textblock has lines but no `TextGeometry`.
fn fallback_range_rects(
    lines: &[TextLine],
    range: std::ops::Range<u32>,
    out: &mut Vec<Bounds<Points>>,
) {
    if range.start >= range.end {
        return;
    }
    for line in lines {
        if line.end <= range.start || line.start >= range.end {
            continue;
        }
        let x0 = fallback_x(line, range.start.max(line.start));
        let x1 = fallback_x(line, range.end.min(line.end));
        if x1 > x0 {
            out.push(Bounds::new(
                Point::new(x0, line.y),
                Size::new(x1 - x0, line.height),
            ));
        }
    }
}

/// Linear fallback hit test when a textblock has lines but no `TextGeometry`.
fn fallback_hit(lines: &[TextLine], local: Point<Points>) -> (u32, Affinity) {
    let index = lines
        .iter()
        .position(|l| local.y < l.y + l.height)
        .unwrap_or(lines.len() - 1);
    let line = &lines[index];
    let count = line.end.saturating_sub(line.start);
    let share = if line.width > px(0.0) {
        ((local.x - line.x) / line.width).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let offset = line.start + (share * count as f32).round() as u32;
    let affinity = if offset == line.end && index + 1 < lines.len() {
        Affinity::Upstream
    } else {
        Affinity::Downstream
    };
    (offset.min(line.end), affinity)
}

/// The line text offset `t` shows on.
fn line_of(lines: &[TextLine], t: u32, affinity: Affinity) -> Option<usize> {
    if lines.is_empty() {
        return None;
    }
    for (i, line) in lines.iter().enumerate() {
        let last = i + 1 == lines.len();
        if t < line.end || last {
            return Some(i);
        }
        if t == line.end {
            // At a wrap: the upper line upstream, else the next one.
            let next_starts = lines.get(i + 1).is_some_and(|n| n.start == t);
            if affinity == Affinity::Upstream || !next_starts {
                return Some(i);
            }
        }
    }
    Some(lines.len() - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A task item's content holds its blocks after the checkbox: their
    /// frames are in the holder, so the holder's offset is part of where
    /// they are (the caret and the selection of a task's text).
    #[test]
    fn a_holders_inset_is_part_of_its_children_origin() {
        let mut geo = Geometry::default();
        let at =
            |x: f32, y: f32| Bounds::new(Point::new(px(x), px(y)), Size::new(px(100.0), px(20.0)));
        geo.frames.insert(1, (Some(DOC), at(0.0, 40.0)));
        geo.frames.insert(2, (Some(1), at(0.0, 0.0)));
        assert_eq!(geo.origin(2), Some(Point::new(px(0.0), px(40.0))));
        geo.insets.insert(1, Point::new(px(24.0), px(0.0)));
        assert_eq!(geo.origin(2), Some(Point::new(px(24.0), px(40.0))));
        // The item itself is in its own parent's box: no inset of its own.
        assert_eq!(geo.origin(1), Some(Point::new(px(0.0), px(40.0))));
    }

    /// A node view's slot is measured in its block's box, a holder's offset
    /// (a task item's checkbox before it) included: the holder's inset is
    /// not added again on the way up.
    #[test]
    fn a_slot_in_its_block_takes_no_inset_of_the_block() {
        let mut geo = Geometry::default();
        let at =
            |x: f32, y: f32| Bounds::new(Point::new(px(x), px(y)), Size::new(px(100.0), px(20.0)));
        geo.frames.insert(1, (Some(DOC), at(0.0, 40.0)));
        geo.insets.insert(1, Point::new(px(24.0), px(0.0)));
        geo.frames.insert(slot_id(1), (Some(1), at(24.0, 0.0)));
        assert_eq!(geo.origin(slot_id(1)), Some(Point::new(px(24.0), px(40.0))));
        // The block moves: its slot goes with it.
        geo.frames.insert(1, (Some(DOC), at(0.0, 10.0)));
        assert_eq!(geo.origin(slot_id(1)), Some(Point::new(px(24.0), px(10.0))));
    }

    /// The checkbox is in the item's box before its content: a press there
    /// is the checkbox's, wherever the item is in the document.
    #[test]
    fn a_point_before_a_holder_is_on_the_items_checkbox() {
        let mut geo = Geometry::default();
        let at =
            |x: f32, y: f32| Bounds::new(Point::new(px(x), px(y)), Size::new(px(100.0), px(20.0)));
        geo.frames.insert(1, (Some(DOC), at(10.0, 40.0)));
        geo.frames.insert(2, (Some(DOC), at(10.0, 60.0)));
        geo.insets.insert(1, Point::new(px(24.0), px(0.0)));
        let on = |x: f32, y: f32| geo.before_holder(Point::new(px(x), px(y)));
        assert!(on(10.0, 40.0) && on(33.0, 59.0));
        // The item's text, the margin beside it, and a block without a
        // holder are not.
        assert!(!on(34.0, 50.0) && !on(9.0, 50.0) && !on(20.0, 70.0));
    }

    fn map() -> InlineMap {
        // "ab", an atom, a widget before "cd".
        InlineMap {
            runs: vec![
                Run {
                    doc: 0,
                    doc_len: 2,
                    text: 0,
                    text_len: 2,
                    side: 0,
                },
                Run {
                    doc: 2,
                    doc_len: 1,
                    text: 2,
                    text_len: 1,
                    side: 0,
                },
                Run {
                    doc: 3,
                    doc_len: 0,
                    text: 3,
                    text_len: 1,
                    side: -1,
                },
                Run {
                    doc: 3,
                    doc_len: 2,
                    text: 4,
                    text_len: 2,
                    side: 0,
                },
            ],
            size: 5,
            len: 6,
        }
    }

    #[test]
    fn positions_and_text_offsets_map_both_ways() {
        let m = map();
        assert_eq!(m.to_text(0), 0);
        assert_eq!(m.to_text(2), 2);
        // After the widget that sticks before position 3.
        assert_eq!(m.to_text(3), 4);
        assert_eq!(m.to_text(5), 6);
        assert_eq!(m.to_doc(3), 3);
        assert_eq!(m.to_doc(5), 4);
        assert_eq!(m.to_doc(6), 5);
    }

    #[test]
    fn a_leaf_drawn_as_text_is_one_position() {
        // "ab", a mention drawn as "@Alice", "c".
        let run = |doc, doc_len, text, text_len| Run {
            doc,
            doc_len,
            text,
            text_len,
            side: 0,
        };
        let m = InlineMap {
            runs: vec![run(0, 2, 0, 2), run(2, 1, 2, 6), run(3, 1, 8, 1)],
            size: 4,
            len: 9,
        };
        assert_eq!(m.to_text(2), 2);
        assert_eq!(m.to_text(3), 8);
        // Inside its text: the nearer side.
        assert_eq!(m.to_doc(4), 2);
        assert_eq!(m.to_doc(5), 3);
        assert_eq!(m.to_doc(8), 3);
    }
}
