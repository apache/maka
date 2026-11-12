use std::sync::Arc;

use nsh_core::{
    AttachmentAlignments, AttributedText, EllipsizeMode, FontExtent, Point, Points, Size,
    TextAlign, TextEngine, TextLayout, TextLine,
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
                let (ascent, descent) = a.extent(font, alignments.get(start));
                Attachment {
                    index,
                    ascent: (ascent / cells.height()).ceil() as usize,
                    descent: (descent / cells.height()).ceil() as usize,
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
        let mut space = None;
        let mut has_content = false;
        while end < glyphs.len() && !glyphs[end].text.contains('\n') {
            if width + glyphs[end].width > columns && end > start {
                break;
            }
            width += glyphs[end].width;
            if glyphs[end].attachment.is_none() && glyphs[end].text.as_ref() == " " {
                if has_content {
                    space = Some(end);
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
            && let Some(space) = space.filter(|&s| s > start)
        {
            end = space;
            next = space + 1;
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
