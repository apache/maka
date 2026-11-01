//! A text input's text laid out with GPUI's text system, on the main
//! thread: one font, lines broken by nsh (only multiline inputs wrap),
//! caret stops for every character boundary, hit testing and the
//! rectangles of a range.
//!
//! GPUI shapes one line at a time ([`WindowTextSystem::layout_line`]), so
//! each paragraph is shaped whole and then broken at the opportunities
//! [`may_break_after`] finds, as the engine's text does
//! ([`crate::text`]). Positions are UTF-16 offsets of the shown text (the
//! text with the IME's composition, or bullets for a password), which is
//! what [`nsh_core::text_edit::Model`]'s display mapping speaks.
//!
//! Inputs shape on demand (a key moving the caret up a line needs the
//! layout before the next frame is painted), so they share one
//! [`WindowTextSystem`] of their own per thread over the app's
//! [`TextSystem`]; its line cache only grows, so it is made anew every
//! [`CACHE_LINES`] lines.

use std::{cell::RefCell, ops::Range, sync::Arc};

use gpui::{Font, FontId, GlyphId, TextRun, TextSystem, WindowTextSystem, px};

/// How many lines the shaper may cache before it is made anew.
const CACHE_LINES: u32 = 1024;

thread_local! {
    /// The inputs' shaper: the text system it was made over, the shaper
    /// and how many lines it shaped.
    static SHAPER: RefCell<Option<(Arc<TextSystem>, WindowTextSystem, u32)>> =
        const { RefCell::new(None) };
}

/// Runs `f` with the thread's shaper over `system`.
fn with_shaper<R>(system: &Arc<TextSystem>, f: impl FnOnce(&WindowTextSystem) -> R) -> R {
    SHAPER.with(|cell| {
        let mut cell = cell.borrow_mut();
        let fresh = match &*cell {
            Some((s, _, n)) => !Arc::ptr_eq(s, system) || *n >= CACHE_LINES,
            None => true,
        };
        if fresh {
            *cell = Some((system.clone(), WindowTextSystem::new(system.clone()), 0));
        }
        let (_, shaper, n) = cell.as_mut().expect("made above");
        *n += 1;
        f(shaper)
    })
}

/// The font of an input's text.
#[derive(Debug, Clone)]
pub(crate) struct Style {
    /// The font (family, weight, slant).
    pub(crate) font: Font,
    /// Font size (points).
    pub(crate) size: f32,
    /// Line height (points; 0: the font's).
    pub(crate) line_height: f32,
    /// Extra space after every character.
    pub(crate) spacing: f32,
}

/// One glyph to paint.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Glyph {
    /// The cluster's offset in the shown text (UTF-16).
    pub(crate) offset: u32,
    /// Left edge from its line's.
    pub(crate) x: f32,
    pub(crate) font: FontId,
    pub(crate) id: GlyphId,
    /// Painted from its color bitmap.
    pub(crate) emoji: bool,
}

/// One laid-out line.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Line {
    /// Its range of the shown text (UTF-16; a line break is in neither
    /// line).
    pub(crate) start: u32,
    pub(crate) end: u32,
    /// Left edge (alignment), top, height and baseline (from the top).
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) height: f32,
    pub(crate) baseline: f32,
    /// Width, trailing spaces included.
    pub(crate) width: f32,
    /// Caret stops: offset and x from the line's left edge, every
    /// character boundary from `start` to `end` in order.
    pub(crate) stops: Vec<(u32, f32)>,
    /// Its glyphs in [`Layout::glyphs`].
    pub(crate) glyphs: Range<usize>,
}

impl Line {
    /// The x (from the line's edge) of the stop at or before `pos`.
    fn x_at(&self, pos: u32) -> f32 {
        let i = self.stops.partition_point(|s| s.0 <= pos);
        self.stops.get(i.saturating_sub(1)).map_or(0.0, |s| s.1)
    }
}

/// A laid-out text: at least one line.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Layout {
    pub(crate) lines: Vec<Line>,
    pub(crate) glyphs: Vec<Glyph>,
    /// The font size glyphs are painted at.
    pub(crate) size: f32,
    /// The widest line (trailing spaces included) and the lines' height.
    pub(crate) width: f32,
    pub(crate) height: f32,
}

impl Layout {
    /// The line showing `pos`: at a soft wrap, the line it starts.
    fn line_of(&self, pos: u32) -> usize {
        self.lines
            .partition_point(|l| l.start <= pos)
            .saturating_sub(1)
    }

    /// The line was wrapped (not ended by a line break or the text's end).
    fn soft(&self, line: usize) -> bool {
        self.lines
            .get(line + 1)
            .is_some_and(|next| next.start == self.lines[line].end)
    }

    /// The caret at `pos`: x, top and height.
    pub(crate) fn caret(&self, pos: u32) -> (f32, f32, f32) {
        let l = &self.lines[self.line_of(pos)];
        (l.x + l.x_at(pos), l.y, l.height)
    }

    /// The offset nearest to `(x, y)`.
    pub(crate) fn hit(&self, x: f32, y: f32, allowed: impl Fn(u32) -> bool) -> u32 {
        let i = self
            .lines
            .partition_point(|l| y >= l.y + l.height)
            .min(self.lines.len() - 1);
        let stops = |i: usize| {
            let l = &self.lines[i];
            // A wrapped line's end is the next line's start: shown there.
            if self.soft(i) && l.stops.len() > 1 {
                &l.stops[..l.stops.len() - 1]
            } else {
                &l.stops[..]
            }
        };
        let line = &self.lines[i];
        let at = stops(i)
            .iter()
            .min_by(|a, b| {
                (line.x + a.1 - x)
                    .abs()
                    .total_cmp(&(line.x + b.1 - x).abs())
            })
            .expect("input line has caret stops")
            .0;
        if allowed(at) {
            return at;
        }
        // Stay at the clicked atom's endpoints, even when it wraps across lines.
        let before = self.lines[..=i]
            .iter()
            .rev()
            .flat_map(|line| line.stops.iter().rev())
            .find(|&&(pos, _)| pos < at && allowed(pos))
            .map(|stop| stop.0);
        let after = self.lines[i..]
            .iter()
            .flat_map(|line| line.stops.iter())
            .find(|&&(pos, _)| pos > at && allowed(pos))
            .map(|stop| stop.0);
        let distance = |pos| {
            let (sx, sy, height) = self.caret(pos);
            let dy = (sy - y).max(y - sy - height).max(0.0);
            (sx - x).powi(2) + dy * dy
        };
        before
            .into_iter()
            .chain(after)
            .min_by(|&a, &b| distance(a).total_cmp(&distance(b)))
            .unwrap_or(0)
    }

    /// The start and end of the line showing `pos` (the end of a wrapped
    /// line stays on it, before its trailing space).
    pub(crate) fn line_edges(&self, pos: u32) -> (u32, u32) {
        let i = self.line_of(pos);
        let l = &self.lines[i];
        let end = if self.soft(i) && l.stops.len() > 1 {
            l.stops[l.stops.len() - 2].0
        } else {
            l.end
        };
        (l.start, end)
    }

    /// The rectangles (x, y, width, height) covering `from..to`, one per
    /// line; a line break in the range shows as an empty rectangle at the
    /// line's end.
    pub(crate) fn rects(&self, from: u32, to: u32) -> Vec<(f32, f32, f32, f32)> {
        let mut out = Vec::new();
        if from >= to {
            return out;
        }
        for (i, l) in self.lines.iter().enumerate() {
            if to < l.start || from > l.end {
                continue;
            }
            let (a, b) = (from.max(l.start), to.min(l.end));
            if a == b && (to <= l.end || self.soft(i)) {
                continue;
            }
            let (x0, x1) = (l.x_at(a), l.x_at(b));
            out.push((l.x + x0, l.y, x1 - x0, l.height));
        }
        out
    }
}

/// True when a line may break after `a` (followed by `b`): after spaces,
/// around CJK ideographs, after hyphens and slashes inside words.
pub(crate) fn may_break_after(a: char, b: Option<char>) -> bool {
    let Some(b) = b else { return false };
    if a.is_whitespace() {
        return !b.is_whitespace();
    }
    if b.is_whitespace() {
        return false;
    }
    if is_cjk(a) || is_cjk(b) {
        return true;
    }
    matches!(a, '-' | '/' | '\u{2010}' | '\u{2013}') && b.is_alphanumeric()
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x11FF | 0x2E80..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF
        | 0xFF00..=0xFFEF | 0x20000..=0x3FFFF)
}

/// Where the lines of `chars` start (character indices, the first 0)
/// when broken at `width`; `xs` are the caret positions before each
/// character and after the last (`chars.len() + 1` of them). Spaces may
/// hang past the width; a word longer than a line breaks anywhere.
pub(crate) fn wrap(chars: &[char], xs: &[f32], width: f32) -> Vec<usize> {
    let mut starts = vec![0];
    let mut start = 0;
    let mut last_break: Option<usize> = None;
    for i in 0..chars.len() {
        if !chars[i].is_whitespace() && i > start && xs[i + 1] - xs[start] > width + 0.01 {
            let cut = last_break.filter(|b| *b > start).unwrap_or(i);
            starts.push(cut);
            start = cut;
            last_break = (cut..i)
                .rev()
                .find(|&j| may_break_after(chars[j], chars.get(j + 1).copied()))
                .map(|j| j + 1);
        }
        if may_break_after(chars[i], chars.get(i + 1).copied()) {
            last_break = Some(i + 1);
        }
    }
    starts
}

/// One paragraph shaped on one line.
struct Paragraph {
    chars: Vec<char>,
    /// UTF-16 offset (in the paragraph) and x of every character boundary.
    stops: Vec<(u32, f32)>,
    /// Glyphs: UTF-16 offset of the cluster, x, font, id, emoji.
    glyphs: Vec<(u32, f32, FontId, GlyphId, bool)>,
}

fn shape_paragraph(shaper: &WindowTextSystem, text: &str, style: &Style) -> Paragraph {
    let chars: Vec<char> = text.chars().collect();
    let mut stops = Vec::with_capacity(chars.len() + 1);
    let mut glyphs = Vec::new();
    if text.is_empty() {
        stops.push((0, 0.0));
        return Paragraph {
            chars,
            stops,
            glyphs,
        };
    }
    let run = TextRun {
        len: text.len(),
        font: style.font.clone(),
        color: gpui::black(),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let line = shaper.layout_line(text, px(style.size), &[run], None);
    // Character index and UTF-16 offset of every byte that starts one.
    let mut char_of = vec![(0usize, 0u32); text.len() + 1];
    let mut u = 0u32;
    for (ci, (b, c)) in text.char_indices().enumerate() {
        char_of[b] = (ci, u);
        u += c.len_utf16() as u32;
    }
    char_of[text.len()] = (chars.len(), u);
    let spacing = style.spacing;
    // Glyphs by cluster byte, in logical order.
    let mut by_index: Vec<(usize, f32)> = Vec::new();
    for run in &line.runs {
        for g in &run.glyphs {
            let (ci, u) = char_of[g.index.min(text.len())];
            let x = f32::from(g.position.x) + spacing * ci as f32;
            glyphs.push((u, x, run.font_id, g.id, g.is_emoji));
            by_index.push((g.index, x));
        }
    }
    by_index.sort_by_key(|g| g.0);
    let end = f32::from(line.width) + spacing * chars.len() as f32;
    for (b, _) in text
        .char_indices()
        .chain(std::iter::once((text.len(), ' ')))
    {
        let u = char_of[b].1;
        let i = by_index.partition_point(|g| g.0 < b);
        let x = match by_index.get(i) {
            Some(g) if b < text.len() => g.1.min(end),
            _ => end,
        };
        stops.push((u, x));
    }
    Paragraph {
        chars,
        stops,
        glyphs,
    }
}

/// The font's ascent and descent at the style's size.
fn metrics(system: &TextSystem, style: &Style) -> (f32, f32) {
    let id = system.resolve_font(&style.font);
    let size = px(style.size);
    (
        f32::from(system.ascent(id, size)),
        f32::from(system.descent(id, size)).abs(),
    )
}

/// Lays `text` out: on one line, or (with `wrap`) in lines that width,
/// each placed by `align` (0: left, 1: right). `ellipsis` cuts a single
/// line wider than `ellipsis` points with "…".
pub(crate) fn layout(
    system: &Arc<TextSystem>,
    text: &str,
    style: &Style,
    wrap_width: Option<f32>,
    align: f32,
    ellipsis: Option<f32>,
) -> Layout {
    let (ascent, descent) = metrics(system, style);
    let height = if style.line_height > 0.0 {
        style.line_height
    } else {
        ascent + descent
    };
    let baseline = (height - ascent - descent) / 2.0 + ascent;
    let mut lines = Vec::new();
    let mut glyphs = Vec::new();
    let mut offset = 0u32;
    let mut y = 0.0;
    let mut widest: f32 = 0.0;
    with_shaper(system, |shaper| {
        let mut remaining = text;
        loop {
            let end = remaining.find(['\r', '\n']).unwrap_or(remaining.len());
            let para = &remaining[..end];
            let ending = if remaining[end..].starts_with("\r\n") {
                2
            } else {
                usize::from(end < remaining.len())
            };
            let mut p = shape_paragraph(shaper, para, style);
            if let Some(max) = ellipsis
                && wrap_width.is_none()
            {
                cut_with_ellipsis(shaper, style, &mut p, max);
            }
            let xs: Vec<f32> = p.stops.iter().map(|s| s.1).collect();
            let mut starts = match wrap_width {
                Some(w) => wrap(&p.chars, &xs, w),
                None => vec![0],
            };
            starts.push(p.chars.len());
            for pair in starts.windows(2) {
                let (c0, c1) = (pair[0], pair[1]);
                let (u0, x0) = p.stops[c0];
                let (u1, x1) = p.stops[c1];
                let first = glyphs.len();
                for &(u, x, font, id, emoji) in &p.glyphs {
                    if u >= u0 && (u < u1 || (c1 == p.chars.len() && u >= u1)) {
                        glyphs.push(Glyph {
                            offset: offset + u,
                            x: x - x0,
                            font,
                            id,
                            emoji,
                        });
                    }
                }
                let mut visible = c1;
                while visible > c0 && p.chars[visible - 1].is_whitespace() {
                    visible -= 1;
                }
                let visible_width = p.stops[visible].1 - x0;
                let x = match wrap_width {
                    Some(w) => ((w - visible_width) * align).max(0.0),
                    None => 0.0,
                };
                widest = widest.max(x1 - x0);
                lines.push(Line {
                    start: offset + u0,
                    end: offset + u1,
                    x,
                    y,
                    height,
                    baseline,
                    width: x1 - x0,
                    stops: p.stops[c0..=c1]
                        .iter()
                        .map(|&(u, sx)| (offset + u, sx - x0))
                        .collect(),
                    glyphs: first..glyphs.len(),
                });
                y += height;
            }
            offset += p.stops.last().map_or(0, |s| s.0) + ending as u32;
            if ending == 0 {
                break;
            }
            remaining = &remaining[end + ending..];
        }
    });
    Layout {
        lines,
        glyphs,
        size: style.size,
        width: widest,
        height: y,
    }
}

/// Cuts a paragraph wider than `max` before the character that does not
/// fit with "…" after it, and puts the ellipsis there.
fn cut_with_ellipsis(shaper: &WindowTextSystem, style: &Style, p: &mut Paragraph, max: f32) {
    let width = p.stops.last().map_or(0.0, |s| s.1);
    if width <= max {
        return;
    }
    let dots = shape_paragraph(shaper, "\u{2026}", style);
    let dots_w = dots.stops.last().map_or(0.0, |s| s.1);
    let keep = p
        .stops
        .iter()
        .rposition(|s| s.1 + dots_w <= max)
        .unwrap_or(0);
    let (u, x) = p.stops[keep];
    p.glyphs.retain(|g| g.0 < u);
    p.glyphs.extend(
        dots.glyphs
            .iter()
            .map(|&(_, gx, font, id, emoji)| (u, x + gx, font, id, emoji)),
    );
    p.chars.truncate(keep);
    p.chars.push('\u{2026}');
    p.stops.truncate(keep + 1);
    p.stops.push((u + 1, x + dots_w));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A layout of `lines` (text, line start offset) in a monospace font
    /// 10 points per character, 20 points per line.
    fn mono(lines: &[(&str, u32)]) -> Layout {
        let mut out = Vec::new();
        for (i, (text, start)) in lines.iter().enumerate() {
            let n = text.chars().count() as u32;
            out.push(Line {
                start: *start,
                end: start + n,
                x: 0.0,
                y: i as f32 * 20.0,
                height: 20.0,
                baseline: 15.0,
                width: n as f32 * 10.0,
                stops: (0..=n).map(|k| (start + k, k as f32 * 10.0)).collect(),
                glyphs: 0..0,
            });
        }
        Layout {
            lines: out,
            glyphs: Vec::new(),
            size: 14.0,
            width: 0.0,
            height: lines.len() as f32 * 20.0,
        }
    }

    #[test]
    fn wraps_at_spaces_and_inside_long_words() {
        let chars: Vec<char> = "ab cd efghijkl".chars().collect();
        let xs: Vec<f32> = (0..=chars.len()).map(|i| i as f32 * 10.0).collect();
        // 50 points: "ab cd " / "efghi" / "jkl".
        assert_eq!(wrap(&chars, &xs, 50.0), vec![0, 6, 11]);
        // Wide enough: one line; spaces hang.
        assert_eq!(wrap(&chars, &xs, 1000.0), vec![0]);
        let chars: Vec<char> = "ab    ".chars().collect();
        let xs: Vec<f32> = (0..=chars.len()).map(|i| i as f32 * 10.0).collect();
        assert_eq!(wrap(&chars, &xs, 30.0), vec![0]);
    }

    #[test]
    fn wraps_between_ideographs() {
        let chars: Vec<char> = "中文输入法".chars().collect();
        let xs: Vec<f32> = (0..=chars.len()).map(|i| i as f32 * 20.0).collect();
        assert_eq!(wrap(&chars, &xs, 45.0), vec![0, 2, 4]);
        assert!(may_break_after('a', Some('中')));
        assert!(may_break_after('-', Some('b')));
        assert!(!may_break_after('a', Some('b')));
        assert!(!may_break_after(' ', Some(' ')));
    }

    #[test]
    fn carets_and_hits() {
        // "hello " wrapped before "world", then a line break and "x".
        let l = mono(&[("hello ", 0), ("world", 6), ("x", 12)]);
        assert_eq!(l.caret(0), (0.0, 0.0, 20.0));
        assert_eq!(l.caret(3), (30.0, 0.0, 20.0));
        // The wrap point shows at the next line's start.
        assert_eq!(l.caret(6), (0.0, 20.0, 20.0));
        // The end of the paragraph, before the line break.
        assert_eq!(l.caret(11), (50.0, 20.0, 20.0));
        assert_eq!(l.caret(12), (0.0, 40.0, 20.0));
        assert_eq!(l.hit(24.0, 5.0, |_| true), 2);
        assert_eq!(l.hit(26.0, 5.0, |_| true), 3);
        // Past a wrapped line's end: before its trailing space's end.
        assert_eq!(l.hit(500.0, 5.0, |_| true), 5);
        assert_eq!(l.hit(500.0, 25.0, |_| true), 11);
        assert_eq!(l.hit(-5.0, 500.0, |_| true), 12);
        // Caret stops inside an atom are not mouse targets. A token may
        // cover the entire middle line of a wrapped paragraph.
        assert_eq!(l.hit(24.0, 5.0, |at| !(1..5).contains(&at)), 0);
        assert_eq!(l.hit(26.0, 5.0, |at| !(1..5).contains(&at)), 5);
        assert_eq!(l.hit(0.0, 25.0, |at| !(1..11).contains(&at)), 0);
        assert_eq!(l.hit(50.0, 25.0, |at| !(1..11).contains(&at)), 11);
        assert_eq!(l.line_edges(2), (0, 5));
        assert_eq!(l.line_edges(8), (6, 11));
    }

    #[test]
    fn range_rects() {
        let l = mono(&[("hello ", 0), ("world", 6), ("x", 12)]);
        assert_eq!(l.rects(1, 3), vec![(10.0, 0.0, 20.0, 20.0)]);
        assert_eq!(
            l.rects(4, 8),
            vec![(40.0, 0.0, 20.0, 20.0), (0.0, 20.0, 20.0, 20.0)]
        );
        // Across the line break: the break shows as an empty rectangle.
        assert_eq!(
            l.rects(10, 13),
            vec![(40.0, 20.0, 10.0, 20.0), (0.0, 40.0, 10.0, 20.0)]
        );
        // Only the line break: a sliver at the end of its line.
        assert_eq!(l.rects(11, 12), vec![(50.0, 20.0, 0.0, 20.0)]);
        assert!(l.rects(3, 3).is_empty());
    }
}
