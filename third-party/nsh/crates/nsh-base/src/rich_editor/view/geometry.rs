//! Where the document is on screen: the blocks' frames as their views
//! report them, the lines the core laid each textblock's text out in
//! (`onTextLayout`), and the map between a textblock's document positions
//! and the offsets of its rendered text (atoms and widgets are one
//! character there). From them: the caret's box at a position, the boxes
//! of a range, and the position at a point. Document positions and visual
//! places stay apart: a position at a line wrap is two places, which the
//! selection's affinity tells apart.

use std::collections::HashMap;

use nsh_core::{TextLine, prelude::*};
use unicode_segmentation::UnicodeSegmentation;

use crate::rich_editor::state::Affinity;

/// The block id of the document itself (its children's parent).
pub(crate) const DOC: u64 = 0;

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
    /// The lines of its text, in the text's box.
    pub(crate) lines: Vec<TextLine>,
    /// The text's frame in its block's box.
    pub(crate) frame: Bounds<Points>,
    /// The box the frame is in (the block's own, else a node view's
    /// content slot).
    pub(crate) owner: Option<u64>,
}

/// The geometry of a rendered document.
#[derive(Default)]
pub(crate) struct Geometry {
    /// Each block's frame in its parent's box, and its parent; `None` for
    /// a frame measured in the content box directly (a content slot).
    pub(crate) frames: HashMap<u64, (Option<u64>, Bounds<Points>)>,
    /// The textblocks, by block id.
    pub(crate) texts: HashMap<u64, TextGeo>,
    /// The atoms and node views edited as units, by block id: their
    /// position.
    pub(crate) atoms: HashMap<u64, usize>,
    /// The font measuring within a line (relative widths only).
    pub(crate) font: String,
}

/// A place a point lands on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Hit {
    /// A position in a textblock, with the side of a wrap it showed on.
    Text(usize, Affinity),
    /// An atom block (its position).
    Node(usize),
}

impl Geometry {
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
                Some(p) => Some(*p),
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
        self.texts
            .iter()
            .find(|(_, g)| pos >= g.start && pos <= g.start + g.map.size)
            .map(|(id, _)| *id)
    }

    /// The caret's box at `pos`: as high as its line, without width.
    pub(crate) fn caret_rect(&self, pos: usize, affinity: Affinity) -> Option<Bounds<Points>> {
        let id = self.text_at(pos)?;
        let (origin, geo) = self.text_box(id)?;
        let t = geo.map.to_text(pos - geo.start);
        let (x, y, h) = match line_of(&geo.lines, t, affinity) {
            Some(i) => {
                let line = &geo.lines[i];
                (line.x + self.x_in_line(line, t), line.y, line.height)
            }
            None => (px(0.0), px(0.0), geo.frame.size.height.max(px(1.0))),
        };
        Some(Bounds::new(
            Point::new(origin.x + x, origin.y + y),
            Size::new(px(0.0), h),
        ))
    }

    /// The boxes covering `from..to`, one per line of each textblock it
    /// crosses (through a line's end where it goes on).
    pub(crate) fn range_rects(&self, from: usize, to: usize) -> Vec<Bounds<Points>> {
        let mut out = Vec::new();
        let mut ids: Vec<(&u64, &TextGeo)> = self.texts.iter().collect();
        ids.sort_by_key(|(_, g)| g.start);
        for (id, geo) in ids {
            let (start, end) = (geo.start, geo.start + geo.map.size);
            if end < from || start > to {
                continue;
            }
            let Some((origin, _)) = self.text_box(*id) else {
                continue;
            };
            let a = geo.map.to_text(from.max(start) - start);
            let b = geo.map.to_text(to.min(end) - start);
            for line in &geo.lines {
                if line.end < a || line.start > b {
                    continue;
                }
                let x0 = if a > line.start {
                    self.x_in_line(line, a)
                } else {
                    px(0.0)
                };
                let through =
                    to > end || b > line.end || (b == line.end && to > start + geo.map.to_doc(b));
                let x1 = if b < line.end || (b == line.end && !through) {
                    self.x_in_line(line, b)
                } else {
                    line.width + px(4.0)
                };
                if x1 <= x0 && !(through && a <= line.end) {
                    continue;
                }
                out.push(Bounds::new(
                    Point::new(origin.x + line.x + x0, origin.y + line.y),
                    Size::new((x1 - x0).max(px(4.0)), line.height),
                ));
            }
            if geo.lines.is_empty() && from <= start && to > end {
                out.push(Bounds::new(
                    origin,
                    Size::new(px(4.0), geo.frame.size.height),
                ));
            }
        }
        out
    }

    /// Where `x` of a line falls: the nearest boundary between graphemes.
    fn offset_in_line(&self, line: &TextLine, x: Points) -> u32 {
        if x <= px(0.0) || line.text.is_empty() {
            return line.start;
        }
        if x >= line.width {
            return line.end;
        }
        let full = measure_text(&self.font, &line.text).max(px(1.0));
        let mut best = (line.start, Points(f32::MAX));
        let mut units = 0u32;
        let mut boundaries = vec![(0u32, 0usize)];
        for g in line.text.graphemes(true) {
            units += g.encode_utf16().count() as u32;
            boundaries.push((units, 0));
        }
        let mut byte = 0usize;
        for (i, g) in line.text.graphemes(true).enumerate() {
            byte += g.len();
            boundaries[i + 1].1 = byte;
        }
        for (u, b) in boundaries {
            let w = if b == 0 {
                px(0.0)
            } else {
                line.width * (measure_text(&self.font, &line.text[..b]).0 / full.0)
            };
            let d = Points((w - x).0.abs());
            if d < best.1 {
                best = (line.start + u, d);
            }
        }
        best.0.min(line.end)
    }

    /// The x of text offset `t` in a line (from the line's left).
    fn x_in_line(&self, line: &TextLine, t: u32) -> Points {
        if t <= line.start || line.text.is_empty() {
            return px(0.0);
        }
        if t >= line.end {
            return line.width;
        }
        let units: Vec<u16> = line.text.encode_utf16().collect();
        let k = ((t - line.start) as usize).min(units.len());
        let prefix = String::from_utf16_lossy(&units[..k]);
        let full = measure_text(&self.font, &line.text).max(px(1.0));
        line.width * (measure_text(&self.font, &prefix).0 / full.0)
    }

    /// The place at `p` (content box): an atom it is on, else the nearest
    /// textblock's nearest position.
    pub(crate) fn hit(&self, p: Point<Points>) -> Option<Hit> {
        for (id, pos) in &self.atoms {
            if let (Some(origin), Some((_, frame))) = (self.origin(*id), self.frames.get(id)) {
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
        for id in self.texts.keys() {
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
        let index = geo
            .lines
            .iter()
            .position(|l| local.y < l.y + l.height)
            .unwrap_or(geo.lines.len() - 1);
        let line = &geo.lines[index];
        let t = self.offset_in_line(line, local.x - line.x);
        // The end of a wrapped line shows on that line.
        let affinity = if t == line.end && index + 1 < geo.lines.len() {
            Affinity::Upstream
        } else {
            Affinity::Downstream
        };
        Some(Hit::Text(geo.start + geo.map.to_doc(t), affinity))
    }

    /// The line `pos` shows on in its textblock, and how many lines the
    /// textblock has.
    pub(crate) fn line_index(&self, pos: usize, affinity: Affinity) -> Option<(usize, usize)> {
        let id = self.text_at(pos)?;
        let geo = self.texts.get(&id)?;
        let t = geo.map.to_text(pos - geo.start);
        Some((line_of(&geo.lines, t, affinity)?, geo.lines.len()))
    }

    /// The start or end of the line `pos` shows on.
    pub(crate) fn line_edge(&self, pos: usize, affinity: Affinity, end: bool) -> Option<usize> {
        let id = self.text_at(pos)?;
        let geo = self.texts.get(&id)?;
        let t = geo.map.to_text(pos - geo.start);
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
}
