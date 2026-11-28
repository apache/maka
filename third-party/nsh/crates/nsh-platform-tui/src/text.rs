use std::{ops::Range, sync::Arc};

use nsh_core::{
    Affinity, AttachmentAlignments, AttributedText, Bounds, EllipsizeMode, FontExtent, Point,
    Points, Size, TextAlign, TextEngine, TextLayout, TextLine, TextPosition,
};
use ratatui_core::style::{Modifier, Style};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::CellSize;

/// Text measured on a fixed grid, independent of the requested font size.
#[derive(Default)]
#[non_exhaustive]
pub struct CellTextEngine {
    cells: CellSize,
}

/// Whether a row may break between `before` and `after` without a space:
/// either is an ideograph (or kana, hangul, a full-width form), `after` is
/// no closing mark and `before` no opening one.
fn breaks_between(before: &Glyph, after: &Glyph) -> bool {
    let (Some(b), Some(a)) = (before.text.chars().next_back(), after.text.chars().next()) else {
        return false;
    };
    if before.attachment.is_some() || after.attachment.is_some() {
        return false;
    }
    (ideographic(b) || ideographic(a))
        && !closing(a)
        && !opening(b)
        && !a.is_whitespace()
        && !b.is_whitespace()
}

/// A character text breaks around (UAX #14's ID class, roughly).
fn ideographic(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x115F       // Hangul Jamo
        | 0x2E80..=0x303E     // CJK radicals, punctuation
        | 0x3041..=0x33FF     // kana, CJK compatibility
        | 0x3400..=0x4DBF     // CJK extension A
        | 0x4E00..=0x9FFF     // CJK unified ideographs
        | 0xA960..=0xA97F
        | 0xAC00..=0xD7A3     // Hangul syllables
        | 0xF900..=0xFAFF     // CJK compatibility ideographs
        | 0xFE30..=0xFE4F     // CJK compatibility forms
        | 0xFF00..=0xFFEF     // full-width forms
        | 0x20000..=0x3FFFD)
}

/// A mark that never starts a row (kinsoku's 行頭禁則).
fn closing(c: char) -> bool {
    matches!(
        c,
        '，' | '。'
            | '、'
            | '；'
            | '：'
            | '！'
            | '？'
            | '）'
            | '」'
            | '』'
            | '】'
            | '》'
            | '〉'
            | '〕'
            | '］'
            | '｝'
            | '…'
            | '‥'
            | '・'
            | 'ー'
            | '々'
            | '〜'
            | '％'
            | ','
            | '.'
            | ';'
            | ':'
            | '!'
            | '?'
            | ')'
            | ']'
            | '}'
            | '%'
            | 'ぁ'
            | 'ぃ'
            | 'ぅ'
            | 'ぇ'
            | 'ぉ'
            | 'っ'
            | 'ゃ'
            | 'ゅ'
            | 'ょ'
            | 'ァ'
            | 'ィ'
            | 'ゥ'
            | 'ェ'
            | 'ォ'
            | 'ッ'
            | 'ャ'
            | 'ュ'
            | 'ョ'
    )
}

/// A mark that never ends a row (行末禁則).
fn opening(c: char) -> bool {
    matches!(
        c,
        '（' | '「' | '『' | '【' | '《' | '〈' | '〔' | '［' | '｛' | '(' | '[' | '{'
    )
}

impl CellTextEngine {
    /// Uses the same Cell dimensions as the surface that draws the text.
    pub fn new(cells: CellSize) -> Self {
        Self { cells }
    }
}

#[derive(Clone)]
pub(crate) struct Glyph {
    pub(crate) text: Arc<str>,
    start: u32,
    end: u32,
    pub(crate) width: usize,
    style: Style,
    color: Option<nsh_core::Color>,
    background: Option<nsh_core::Color>,
    /// The underline's own color (`textDecorationColor`), when underlined.
    decoration: Option<nsh_core::Color>,
    attachment: Option<Attachment>,
}

#[derive(Clone, Copy)]
struct Attachment {
    index: usize,
    ascent: usize,
    descent: usize,
}

/// Opaque text prepared once for the core's repeated layout measurements.
#[derive(Default)]
#[non_exhaustive]
pub struct PreparedText {
    text: AttributedText,
    glyphs: Vec<Glyph>,
}

pub(crate) struct CellLayout {
    /// The displayed rows: what is drawn, and searched on screen.
    pub(crate) rows: Vec<Row>,
    metrics: Vec<TextLine>,
    attachments: Vec<Option<Point<Points>>>,
    pub(crate) glyphs: Vec<(nsh_core::Bounds<Points>, std::ops::Range<u32>)>,
}

impl CellLayout {
    fn line_glyphs(&self, line: &TextLine) -> impl Iterator<Item = &(Bounds<Points>, Range<u32>)> {
        let first = self
            .glyphs
            .partition_point(|(_, range)| range.end <= line.start);
        let end = line.end;
        self.glyphs[first..]
            .iter()
            .take_while(move |(_, range)| range.start < end)
    }

    fn caret_x(&self, line: &TextLine, offset: u32) -> Points {
        self.line_glyphs(line)
            .find(|(_, range)| offset < range.end)
            .map_or(line.x + line.width, |(bounds, _)| bounds.left())
    }
}

pub(crate) struct Row {
    pub(crate) indent: usize,
    pub(crate) glyphs: Vec<Glyph>,
}

impl Glyph {
    /// The characters it draws (UTF-16 offsets of the text).
    pub(crate) fn range(&self) -> std::ops::Range<u32> {
        self.start..self.end
    }

    /// Bold, italic, underline and strike-through, as the run sets them.
    pub(crate) fn modifiers(&self) -> Modifier {
        self.style.add_modifier
    }

    /// The run's color.
    pub(crate) fn color(&self) -> Option<nsh_core::Color> {
        self.color
    }

    /// The color of the run's underline, when it has one of its own.
    pub(crate) fn decoration(&self) -> Option<nsh_core::Color> {
        self.decoration
    }

    /// The run's own background.
    pub(crate) fn background(&self) -> Option<nsh_core::Color> {
        self.background
    }

    /// Whether the glyph only reserves Cells for an inline view, which
    /// draws itself.
    pub(crate) fn is_attachment(&self) -> bool {
        self.attachment.is_some()
    }
}

fn glyphs(text: &AttributedText, cells: CellSize, alignments: &AttachmentAlignments) -> Vec<Glyph> {
    let mut offset = 0;
    text.text
        .graphemes(true)
        .map(|grapheme| {
            let start = offset;
            offset += grapheme.encode_utf16().count() as u32;
            let mut style = Style::default();
            let span = text.span_at(start);
            if let Some(span) = span {
                if span.style.font_weight >= 600 {
                    style = style.add_modifier(Modifier::BOLD);
                }
                if span.style.italic {
                    style = style.add_modifier(Modifier::ITALIC);
                }
                if span.style.decoration.underline {
                    style = style.add_modifier(Modifier::UNDERLINED);
                }
                if span.style.decoration.line_through {
                    style = style.add_modifier(Modifier::CROSSED_OUT);
                }
            }
            let attachment = text
                .attachments
                .iter()
                .enumerate()
                .find(|(_, a)| a.index == start);
            let width = attachment.map_or_else(
                || grapheme.width(),
                |(_, a)| (a.width / cells.width()).ceil() as usize,
            );
            let attachment = attachment.map(|(index, a)| {
                let font = FontExtent::new(cells.height(), Points::ZERO, cells.height() / 2.0);
                let (ascent, descent) = alignments.extent(a, font);
                // Its rows as a whole, split at the baseline's nearest row
                // line: rounding each side up would give a one-row view
                // centered on the text (`middle`) a row above and below.
                let rows = ((ascent + descent) / cells.height() - 1.0e-4)
                    .ceil()
                    .max(0.0) as usize;
                let above = ((ascent / cells.height() + 0.5).floor().max(0.0) as usize).min(rows);
                Attachment {
                    index,
                    ascent: above,
                    descent: rows - above,
                }
            });
            // A hidden run (`visibility: "hidden"`) keeps its Cells and
            // shows nothing in them: a terminal draws no transparent text.
            let hidden = span.is_some_and(|span| span.style.hidden);
            if hidden {
                style = Style::default();
            }
            Glyph {
                text: if attachment.is_some() || hidden {
                    Arc::from(" ".repeat(width))
                } else {
                    Arc::from(grapheme)
                },
                start,
                end: offset,
                width,
                style,
                color: span.map(|span| span.style.color),
                background: span
                    .and_then(|span| span.style.background)
                    .map(|background| background.color),
                decoration: span
                    .filter(|span| span.style.decoration.underline)
                    .and_then(|span| span.style.decoration_color),
                attachment,
            }
        })
        .collect()
}

fn wrap(glyphs: &[Glyph], columns: usize) -> Vec<Vec<Glyph>> {
    let mut rows = Vec::new();
    let mut start = 0;
    while start < glyphs.len() {
        let mut end = start;
        let mut width = 0;
        // The last place the row may break: `(end, next)`, the row ending
        // at `end` and the next starting at `next` (a space between them is
        // dropped).
        let mut space: Option<(usize, usize)> = None;
        let mut has_content = false;
        while end < glyphs.len() && !glyphs[end].text.contains('\n') {
            if width + glyphs[end].width > columns && end > start {
                break;
            }
            // Ideographic text (Chinese, Japanese, Korean) breaks between
            // any two of its characters, as UAX #14 has it, but a closing
            // mark (`，`、`。`、`）`) never starts a row, nor does an
            // opening one (`（`、`「`) end one.
            if has_content && end > start && breaks_between(&glyphs[end - 1], &glyphs[end]) {
                space = Some((end, end));
            }
            width += glyphs[end].width;
            if glyphs[end].attachment.is_none() && glyphs[end].text.as_ref() == " " {
                if has_content {
                    space = Some((end, end + 1));
                }
            } else {
                has_content = true;
            }
            end += 1;
        }
        let mut next = end;
        if end < glyphs.len() && glyphs[end].text.contains('\n') {
            next += 1;
        } else if end < glyphs.len()
            && glyphs[end].attachment.is_none()
            && glyphs[end].text.as_ref() == " "
        {
            while next < glyphs.len()
                && glyphs[next].attachment.is_none()
                && glyphs[next].text.as_ref() == " "
            {
                next += 1;
            }
        } else if end < glyphs.len()
            && end > start
            && breaks_between(&glyphs[end - 1], &glyphs[end])
        {
            // The row is full right at a break between two ideographs.
        } else if end < glyphs.len()
            && let Some((at, after)) = space.filter(|&(s, _)| s > start)
        {
            end = at;
            next = after;
        }
        rows.push(glyphs[start..end].to_vec());
        start = next;
    }
    if glyphs.is_empty() || glyphs.last().is_some_and(|g| g.text.contains('\n')) {
        rows.push(Vec::new());
    }
    rows
}

impl CellTextEngine {
    fn rows(&self, prepared: &PreparedText, width: Option<Points>) -> Vec<Vec<Glyph>> {
        let text = &prepared.text;
        let columns = if text.no_wrap {
            usize::MAX
        } else {
            width.map_or(usize::MAX, |w| {
                ((w / self.cells.width() + 0.01).floor() as usize).max(1)
            })
        };
        let glyphs = &prepared.glyphs;
        // A short label of one word (a name, a time, a field's value) a
        // box too narrow for it squeezes stays one row, cut with `…` where
        // the box ends: `ja` / `so` / `n` down a column reads as three
        // words. A longer run (a URL, a path) still breaks to show it all.
        let columns = if one_short_word(glyphs) {
            usize::MAX
        } else {
            columns
        };
        let mut rows = wrap(glyphs, columns);
        if text.max_lines > 0 {
            let limit = text.max_lines as usize;
            let truncated = rows.len() > limit;
            rows.truncate(limit);
            if truncated
                && matches!(text.ellipsize, EllipsizeMode::Head | EllipsizeMode::Middle)
                && let Some(row) = rows.last_mut()
            {
                let start = row.first().map_or(0, |glyph| glyph.start);
                *row = glyphs
                    .iter()
                    .filter(|glyph| glyph.start >= start && !glyph.text.contains('\n'))
                    .cloned()
                    .collect();
            } else if truncated
                && text.ellipsize == EllipsizeMode::Tail
                && let Some(row) = rows.last_mut()
                && let Some(first) = row.first()
            {
                // The last row a clamp shows holds the rest of its
                // paragraph and is cut at the box, as CoreText, Pango and
                // StaticLayout cut it: ending it where it wrapped would
                // leave the ellipsis after a word that fit and the box
                // empty past it.
                let from = glyphs.partition_point(|glyph| glyph.start < first.start);
                *row = glyphs[from..]
                    .iter()
                    .take_while(|glyph| !glyph.text.contains('\n'))
                    .cloned()
                    .collect();
            }
            let available = width.map_or(usize::MAX, |w| {
                (w / self.cells.width() + 0.01).floor() as usize
            });
            if let Some(row) = rows.last_mut()
                && (truncated || row.iter().map(|g| g.width).sum::<usize>() > available)
            {
                ellipsize(row, available, text.ellipsize);
            }
        }
        rows
    }
}

/// The longest word kept on one row when its box is narrower than it.
const SHORT_WORD: usize = 12;

/// Whether `glyphs` are one short word: no space, line break, ideograph
/// or attachment to break at, and at most [`SHORT_WORD`] Cells wide.
fn one_short_word(glyphs: &[Glyph]) -> bool {
    let mut width = 0;
    for (index, glyph) in glyphs.iter().enumerate() {
        if glyph.attachment.is_some()
            || glyph.text.chars().any(char::is_whitespace)
            || (index > 0 && breaks_between(&glyphs[index - 1], glyph))
        {
            return false;
        }
        width += glyph.width;
    }
    width > 0 && width <= SHORT_WORD
}

fn row_extent(row: &[Glyph]) -> (usize, usize) {
    row.iter()
        .filter_map(|g| g.attachment)
        .fold((1, 0), |(ascent, descent), a| {
            (ascent.max(a.ascent), descent.max(a.descent))
        })
}

impl TextEngine for CellTextEngine {
    type Prepared = PreparedText;

    fn prepare(&self, text: &AttributedText) -> Self::Prepared {
        self.prepare_aligned(text, &AttachmentAlignments::default())
    }

    fn prepare_aligned(
        &self,
        text: &AttributedText,
        alignments: &AttachmentAlignments,
    ) -> Self::Prepared {
        PreparedText {
            text: text.clone(),
            glyphs: glyphs(text, self.cells, alignments),
        }
    }

    fn measure(&self, text: &Self::Prepared, width: Option<Points>) -> Size<Points> {
        let rows = self.rows(text, width);
        let columns = rows
            .iter()
            .map(|r| r.iter().map(|g| g.width).sum::<usize>())
            .max()
            .unwrap_or(0);
        Size::new(
            self.cells.width() * columns as f32,
            self.cells.height()
                * rows
                    .iter()
                    .map(|row| {
                        let (ascent, descent) = row_extent(row);
                        ascent + descent
                    })
                    .sum::<usize>() as f32,
        )
    }

    /// The bottom of the first row's own Cells: a Cell is its font's
    /// ascent, with nothing below the baseline.
    fn first_baseline(&self, text: &Self::Prepared, width: Points) -> Option<Points> {
        let rows = self.rows(text, Some(width));
        let (ascent, _) = row_extent(rows.first()?);
        Some(self.cells.height() * ascent as f32)
    }

    fn layout(&self, text: &Self::Prepared, size: Size<Points>) -> TextLayout {
        let rows = self.rows(text, Some(size.width));
        let glyphs = &text.glyphs;
        let text = &text.text;
        let mut displayed = Vec::new();
        let mut metrics = Vec::new();
        let mut selection_glyphs = Vec::new();
        let mut offset = 0;
        let mut top = 0;
        let mut attachments = vec![None; text.attachments.len()];
        for row in rows {
            let (ascent, descent) = row_extent(&row);
            let baseline = top + ascent;
            let glyph_row = baseline - 1;
            let width = row.iter().map(|g| g.width).sum::<usize>();
            let start = row.first().map_or(offset, |g| g.start);
            let end = row.last().map_or(start, |g| g.end);
            offset = glyphs
                .binary_search_by_key(&end, |glyph| glyph.start)
                .ok()
                .and_then(|index| glyphs.get(index))
                .filter(|glyph| glyph.text.contains('\n'))
                .map_or(end, |glyph| glyph.end);
            let columns = (size.width / self.cells.width() + 0.01).floor() as usize;
            let spare = columns.saturating_sub(width);
            let indent = match text.align {
                TextAlign::Center => spare / 2,
                TextAlign::Right => spare,
                TextAlign::Auto if text.rtl => spare,
                _ => 0,
            };
            metrics.push(TextLine {
                text: String::new(),
                start,
                end,
                x: self.cells.width() * indent as f32,
                y: self.cells.height() * top as f32,
                width: self.cells.width() * width as f32,
                height: self.cells.height() * (ascent + descent) as f32,
                ascender: self.cells.height() * ascent as f32,
                descender: self.cells.height() * descent as f32,
                cap_height: self.cells.height(),
                x_height: self.cells.height(),
            });
            let mut column = indent;
            for glyph in &row {
                if let Some(attachment) = glyph.attachment {
                    attachments[attachment.index] = Some(Point::new(
                        self.cells.width() * column as f32,
                        self.cells.height() * (baseline - attachment.ascent) as f32,
                    ));
                }
                selection_glyphs.push((
                    nsh_core::Bounds::new(
                        nsh_core::Point::new(
                            self.cells.width() * column as f32,
                            self.cells.height() * glyph_row as f32,
                        ),
                        Size::new(self.cells.width() * glyph.width as f32, self.cells.height()),
                    ),
                    glyph.start..glyph.end,
                ));
                column += glyph.width;
            }
            while displayed.len() < glyph_row {
                displayed.push(Row {
                    indent: 0,
                    glyphs: Vec::new(),
                });
            }
            displayed.push(Row {
                indent,
                glyphs: row,
            });
            top = baseline + descent;
            while displayed.len() < top {
                displayed.push(Row {
                    indent: 0,
                    glyphs: Vec::new(),
                });
            }
        }
        TextLayout(Arc::new(CellLayout {
            rows: displayed,
            metrics,
            attachments,
            glyphs: selection_glyphs,
        }))
    }

    fn lines(&self, layout: &TextLayout) -> Vec<TextLine> {
        layout
            .downcast::<CellLayout>()
            .map_or_else(Vec::new, |l| l.metrics.clone())
    }

    fn attachments(&self, layout: &TextLayout) -> Vec<Option<Point<Points>>> {
        layout
            .downcast::<CellLayout>()
            .map_or_else(Vec::new, |l| l.attachments.clone())
    }

    fn hit_test(&self, layout: &TextLayout, point: Point<Points>) -> TextPosition {
        let Some(layout) = layout.downcast::<CellLayout>() else {
            return TextPosition::default();
        };
        let Some((index, line)) = layout
            .metrics
            .iter()
            .enumerate()
            .find(|(_, line)| point.y < line.y + line.height)
            .or_else(|| layout.metrics.iter().enumerate().last())
        else {
            return TextPosition::default();
        };
        let offset = layout
            .line_glyphs(line)
            .find(|(bounds, _)| point.x <= bounds.center().x)
            .map_or(line.end, |(_, range)| range.start);
        let affinity = if offset == line.end
            && line.start < offset
            && layout
                .metrics
                .get(index + 1)
                .is_some_and(|next| next.start == offset)
        {
            Affinity::Upstream
        } else {
            Affinity::Downstream
        };
        TextPosition::new(offset, affinity)
    }

    fn caret_rect(&self, layout: &TextLayout, position: TextPosition) -> Option<Bounds<Points>> {
        let layout = layout.downcast::<CellLayout>()?;
        let line = layout.metrics.get(position.line(&layout.metrics)?)?;
        Some(Bounds::new(
            Point::new(layout.caret_x(line, position.offset), line.y),
            Size::new(Points::ZERO, line.height),
        ))
    }

    fn range_rects(&self, layout: &TextLayout, range: Range<u32>, out: &mut Vec<Bounds<Points>>) {
        let Some(layout) = layout.downcast::<CellLayout>() else {
            return;
        };
        for line in &layout.metrics {
            let start = range.start.max(line.start);
            let end = range.end.min(line.end);
            if start < end {
                let x = layout.caret_x(line, start);
                out.push(Bounds::new(
                    Point::new(x, line.y),
                    Size::new(layout.caret_x(line, end) - x, line.height),
                ));
            }
        }
    }

    fn register_font(&self, _: &[u8]) -> Result<(), String> {
        Ok(())
    }
}

fn ellipsize(row: &mut Vec<Glyph>, columns: usize, mode: EllipsizeMode) {
    let marker = usize::from(mode != EllipsizeMode::Clip && columns > 0);
    let budget = columns.saturating_sub(marker);
    let original = std::mem::take(row);
    let mut left = 0;
    let mut right = original.len();
    let mut used = 0;
    let left_budget = match mode {
        EllipsizeMode::Head => 0,
        EllipsizeMode::Middle => budget.div_ceil(2),
        _ => budget,
    };
    while left < original.len() && used + original[left].width <= left_budget {
        used += original[left].width;
        left += 1;
    }
    if mode == EllipsizeMode::Tail && marker > 0 {
        // Spaces before the ellipsis go, as on the other backends.
        while left > 0
            && original[left - 1].attachment.is_none()
            && original[left - 1].text.as_ref() == " "
        {
            left -= 1;
        }
    }
    if matches!(mode, EllipsizeMode::Head | EllipsizeMode::Middle) {
        while right > left && used + original[right - 1].width <= budget {
            right -= 1;
            used += original[right].width;
        }
    }
    row.extend_from_slice(&original[..left]);
    if marker > 0 {
        let at = original.get(left).or_else(|| original.last());
        let offset = original
            .get(left)
            .map_or_else(|| original.last().map_or(0, |g| g.end), |g| g.start);
        row.push(Glyph {
            text: "…".into(),
            start: offset,
            end: offset,
            width: 1,
            style: at.map_or_else(Style::default, |g| g.style),
            color: at.and_then(|g| g.color),
            background: at.and_then(|g| g.background),
            decoration: at.and_then(|g| g.decoration),
            attachment: None,
        });
    }
    row.extend_from_slice(&original[right..]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caret_and_selection_use_the_cells_of_a_wide_glyph() {
        let engine = CellTextEngine::default();
        let mut text = AttributedText::default();
        text.push("a啊b", Default::default());
        let layout = engine.layout(
            &engine.prepare(&text),
            Size::new(Points(80.0), Points(16.0)),
        );
        let caret = engine.hit_test(&layout, Point::new(Points(18.0), Points(8.0)));
        assert_eq!(caret, TextPosition::new(2, Affinity::Downstream));
        assert_eq!(
            engine.caret_rect(&layout, caret).unwrap().left(),
            Points(24.0)
        );
        let mut ranges = Vec::new();
        engine.range_rects(&layout, 1..2, &mut ranges);
        assert_eq!(
            ranges,
            [Bounds::new(
                Point::new(Points(8.0), Points::ZERO),
                Size::new(Points(16.0), Points(16.0)),
            )]
        );
    }
}

#[cfg(test)]
mod wrap_tests {
    use super::*;

    fn glyphs(text: &str) -> Vec<Glyph> {
        text.chars()
            .enumerate()
            .map(|(i, c)| Glyph {
                text: Arc::from(c.to_string()),
                start: i as u32,
                end: i as u32 + 1,
                width: unicode_width::UnicodeWidthChar::width(c).unwrap_or(0),
                style: Style::default(),
                color: None,
                background: None,
                decoration: None,
                attachment: None,
            })
            .collect()
    }

    fn rows(text: &str, columns: usize) -> Vec<String> {
        wrap(&glyphs(text), columns)
            .iter()
            .map(|row| row.iter().map(|g| g.text.as_ref()).collect())
            .collect()
    }

    #[test]
    fn ideographs_break_between_any_two_characters() {
        assert_eq!(
            rows("看看 NSH TUI 实现到底怎么样", 10),
            ["看看 NSH", "TUI 实现到", "底怎么样"]
        );
    }

    #[test]
    fn closing_marks_never_start_a_row_nor_opening_ones_end_one() {
        assert_eq!(rows("一二三四，五六", 8), ["一二三", "四，五六"]);
        assert_eq!(rows("一二三（四五）", 8), ["一二三", "（四五）"]);
    }

    #[test]
    fn latin_words_still_break_only_at_spaces() {
        assert_eq!(rows("hello world", 8), ["hello", "world"]);
    }

    #[test]
    fn a_short_word_is_one_word_but_a_long_run_or_a_phrase_is_not() {
        assert!(one_short_word(&glyphs("jason")));
        assert!(one_short_word(&glyphs("4:35")));
        assert!(!one_short_word(&glyphs(
            "https://github.com/longbridge/nsh"
        )));
        assert!(!one_short_word(&glyphs("ja son")));
        assert!(!one_short_word(&glyphs("中文")));
        assert!(!one_short_word(&glyphs("")));
    }
}
