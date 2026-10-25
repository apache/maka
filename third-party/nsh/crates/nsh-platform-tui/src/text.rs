//! Cell-exact text layout, prepared on the engine thread and painted as-is.
//!
//! Graphemes are indivisible, Unicode line breaking chooses word boundaries,
//! and offsets retain the UTF-16 convention of the shared text pipeline. The
//! terminal supplies its font; weights, italics and decorations use terminal
//! attributes, while explicit leading and letter spacing reserve whole cells.

use std::{borrow::Cow, sync::Arc};

use nsh_core::{
    AttachmentAlignments, AttributedText, Bounds, EllipsizeMode, FontExtent, Point, Points,
    ResolvedTextStyle, Size, TextAlign, TextEngine, TextLayout, TextLine, TextShadow, geometry::px,
};
use ratatui::{
    buffer::Buffer,
    layout::Rect as CellRect,
    style::{Color as TerminalColor, Modifier, Style},
};
use unicode_bidi::{BidiInfo, Level};
use unicode_linebreak::{BreakOpportunity, linebreaks};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::{
    CellMetrics,
    fonts::{FontCatalog, GlyphPaint, tint_bitmap},
    image::Raster,
};

/// A text engine using the host terminal's grapheme and cell geometry.
#[derive(Debug, Clone, Default)]
pub struct TerminalTextEngine {
    metrics: CellMetrics,
    fonts: FontCatalog,
}

impl TerminalTextEngine {
    /// Creates a text engine with the same cell dimensions as its surface.
    pub fn new(metrics: CellMetrics) -> Self {
        Self::with_fonts(metrics, FontCatalog::default())
    }

    pub(crate) fn with_fonts(metrics: CellMetrics, fonts: FontCatalog) -> Self {
        Self { metrics, fonts }
    }
}

#[derive(Debug, Clone)]
struct Cluster {
    text: String,
    start: u32,
    end: u32,
    style: ResolvedTextStyle,
    columns: usize,
    level: Level,
    paragraph_level: Level,
    break_after: bool,
    whitespace: bool,
    newline: bool,
    tab: bool,
    // Original slot, width, height and distance above the baseline.
    attachment: Option<(usize, Points, Points, Points)>,
}

impl Cluster {
    fn columns(&self, column: usize) -> usize {
        if self.tab {
            4 - column % 4
        } else {
            self.columns
        }
    }
}

/// Prepared graphemes and style information, reused at each layout width.
#[derive(Debug)]
pub struct PreparedText {
    clusters: Vec<Cluster>,
    align: TextAlign,
    max_lines: u32,
    ellipsize: EllipsizeMode,
    no_wrap: bool,
    rtl: bool,
    attachment_count: usize,
    empty_style: ResolvedTextStyle,
    shadow: Option<TextShadow>,
}

/// One prepositioned grapheme; its geometry never changes during painting.
#[derive(Debug, Clone)]
pub(crate) struct TerminalRun {
    pub(crate) x: Points,
    pub(crate) y: Points,
    pub(crate) text: String,
    pub(crate) style: ResolvedTextStyle,
    pub(crate) width: u16,
    pub(crate) start: u32,
    pub(crate) end: u32,
    pub(crate) rtl: bool,
}

/// The immutable layout carried across the engine-to-surface mount boundary.
#[derive(Debug)]
pub(crate) struct TerminalLayout {
    pub(crate) runs: Vec<TerminalRun>,
    pub(crate) lines: Vec<TextLine>,
    pub(crate) attachments: Vec<Option<Point<Points>>>,
    shadow: Option<TextShadow>,
    metrics: CellMetrics,
}

impl TerminalLayout {
    /// Visible attachments keep their original UTF-16 placeholder identity.
    pub(crate) fn attachment_rects<'a>(
        &'a self,
        text: &'a AttributedText,
    ) -> impl Iterator<Item = (u32, Bounds<Points>)> + 'a {
        text.attachments
            .iter()
            .zip(&self.attachments)
            .filter_map(|(attachment, at)| {
                let at = (*at)?;
                (attachment.width > Points::ZERO && attachment.height > Points::ZERO).then_some((
                    attachment.index,
                    Bounds::new(at, Size::new(attachment.width, attachment.height)),
                ))
            })
    }
}

#[derive(Debug)]
struct Line {
    start: usize,
    end: usize,
    columns: usize,
    /// A forced break should not be justified.
    forced: bool,
}

fn available_columns(width: Points, metrics: CellMetrics) -> usize {
    if width.is_finite() {
        (width.max(Points::ZERO) / metrics.width() + 0.0001).floor() as usize
    } else {
        usize::MAX
    }
}

fn visual_end(clusters: &[Cluster], start: usize, mut end: usize) -> usize {
    while end > start && clusters[end - 1].whitespace {
        end -= 1;
    }
    end
}

fn columns(clusters: &[Cluster]) -> usize {
    clusters
        .iter()
        .fold(0usize, |x, c| x.saturating_add(c.columns(x)))
}

fn expand_tabs(clusters: &mut [Cluster]) {
    let mut column = 0;
    for cluster in clusters {
        let width = cluster.columns(column);
        if cluster.tab {
            cluster.text = " ".repeat(width);
            cluster.columns = width;
            cluster.tab = false;
        }
        column = column.saturating_add(width);
    }
}

fn printable_character(c: char) -> bool {
    !c.is_control()
        && !matches!(c, '\u{00ad}' | '\u{061c}' | '\u{200b}' | '\u{200e}' | '\u{200f}'
            | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}'
            | '\u{fff9}'..='\u{fffb}')
}

fn line_geometry(
    clusters: &[Cluster],
    fallback: ResolvedTextStyle,
    metrics: CellMetrics,
) -> (Points, Points) {
    let (above, below) = clusters
        .iter()
        .fold((Points::ZERO, Points::ZERO), |(above, below), c| {
            match c.attachment {
                Some((_, _, height, ascent)) => (above.max(ascent), below.max(height - ascent)),
                None => (above, below),
            }
        });
    let requested = clusters
        .iter()
        .fold(fallback.line_height, |h, c| h.max(c.style.line_height));
    let height = (requested.max(above + below).max(metrics.height()) / metrics.height()).ceil()
        * metrics.height();
    // Text uses whole terminal rows, with a cell's bottom as its baseline.
    // Reserve both sides of that baseline for aligned inline views.
    let centered =
        ((height / metrics.height() - 1.0) / 2.0).floor() * metrics.height() + metrics.height();
    let baseline = centered.max((above / metrics.height()).ceil() * metrics.height());
    let height = height.max(baseline + (below / metrics.height()).ceil() * metrics.height());
    (height, baseline)
}

impl PreparedText {
    fn break_lines(&self, max_columns: usize) -> Vec<Line> {
        let max_columns = if self.no_wrap {
            usize::MAX
        } else {
            max_columns
        };
        let mut lines = Vec::new();
        let mut start = 0;
        while start < self.clusters.len() {
            let mut end = start;
            let mut advance = 0usize;
            let mut opportunity = None;
            while end < self.clusters.len() && !self.clusters[end].newline {
                let cluster = &self.clusters[end];
                let next = advance.saturating_add(cluster.columns(advance));
                if next > max_columns && end > start && !cluster.whitespace {
                    break;
                }
                advance = next;
                end += 1;
                if cluster.break_after {
                    opportunity = Some(end);
                }
            }
            let forced = self.clusters.get(end).is_some_and(|c| c.newline);
            if end < self.clusters.len()
                && !forced
                && let Some(at) = opportunity
            {
                end = at;
            }
            // Even an oversized wide grapheme consumes input at a zero-width
            // constraint, so measuring can never loop without making progress.
            if end == start && !forced {
                end = (start + 1).min(self.clusters.len());
            }
            let shown_end = visual_end(&self.clusters, start, end);
            lines.push(Line {
                start,
                end,
                columns: columns(&self.clusters[start..shown_end]),
                forced,
            });
            start = end + usize::from(forced);
        }
        if lines.is_empty() || self.clusters.last().is_some_and(|c| c.newline) {
            lines.push(Line {
                start: self.clusters.len(),
                end: self.clusters.len(),
                columns: 0,
                forced: false,
            });
        }
        lines
    }

    fn shown_lines(&self, count: usize) -> usize {
        if self.max_lines == 0 {
            count
        } else {
            count.min(self.max_lines as usize)
        }
    }

    fn visible_pieces(
        &self,
        line: &Line,
        last: bool,
        hidden_lines: bool,
        max_columns: usize,
    ) -> Cow<'_, [Cluster]> {
        let end = visual_end(&self.clusters, line.start, line.end);
        let visible = &self.clusters[line.start..end];
        let cut = self.max_lines > 0 && last && (hidden_lines || line.columns > max_columns);
        if cut && self.ellipsize != EllipsizeMode::Clip {
            let mut pieces =
                if matches!(self.ellipsize, EllipsizeMode::Head | EllipsizeMode::Middle) {
                    self.clusters[line.start..]
                        .iter()
                        .filter(|c| !c.newline)
                        .cloned()
                        .collect()
                } else {
                    visible.to_vec()
                };
            expand_tabs(&mut pieces);
            ellipsize(&mut pieces, max_columns, self.ellipsize, self.empty_style);
            Cow::Owned(pieces)
        } else if visible.iter().any(|c| c.tab) {
            let mut pieces = visible.to_vec();
            expand_tabs(&mut pieces);
            Cow::Owned(pieces)
        } else {
            Cow::Borrowed(visible)
        }
    }
}

impl TextEngine for TerminalTextEngine {
    type Prepared = PreparedText;

    fn prepare(&self, text: &AttributedText) -> PreparedText {
        self.prepare_aligned(text, &AttachmentAlignments::default())
    }

    fn prepare_aligned(
        &self,
        text: &AttributedText,
        alignments: &AttachmentAlignments,
    ) -> PreparedText {
        let direction = text
            .writing_direction
            .map(|rtl| if rtl { Level::rtl() } else { Level::ltr() });
        let bidi = BidiInfo::new(&text.text, direction);
        let rtl = text.writing_direction.unwrap_or_else(|| {
            bidi.paragraphs
                .first()
                .map_or(text.rtl, |paragraph| paragraph.level.is_rtl())
        });
        let breaks: Vec<_> = linebreaks(&text.text).collect();
        let mut break_index = 0;
        let mut span_index = 0;
        let mut attachment_index = 0;
        let mut paragraph_index = 0;
        let mut utf16 = 0;
        let mut clusters = Vec::new();
        for (byte, grapheme) in text.text.grapheme_indices(true) {
            while paragraph_index + 1 < bidi.paragraphs.len()
                && byte >= bidi.paragraphs[paragraph_index].range.end
            {
                paragraph_index += 1;
            }
            while span_index + 1 < text.spans.len() && utf16 >= text.spans[span_index].end {
                span_index += 1;
            }
            let style = text
                .spans
                .get(span_index)
                .map_or_else(ResolvedTextStyle::default, |s| s.style);
            let end = utf16 + grapheme.encode_utf16().count() as u32;
            let byte_end = byte + grapheme.len();
            while break_index < breaks.len() && breaks[break_index].0 < byte_end {
                break_index += 1;
            }
            let newline = matches!(grapheme, "\n" | "\r" | "\r\n" | "\u{2028}" | "\u{2029}");
            while attachment_index < text.attachments.len()
                && text.attachments[attachment_index].index < utf16
            {
                attachment_index += 1;
            }
            let attachment = text
                .attachments
                .get(attachment_index)
                .filter(|a| a.index == utf16 && grapheme == "\u{fffc}")
                .map(|a| {
                    (
                        attachment_index,
                        a.width.max(Points::ZERO),
                        a.height.max(Points::ZERO),
                        a.ascent(
                            FontExtent::new(
                                self.metrics.height(),
                                Points::ZERO,
                                self.metrics.height() / 2.0,
                            ),
                            alignments.get(a.index),
                        ),
                    )
                });
            let tab = grapheme == "\t";
            // Only the terminal runtime may write control sequences. Stripping
            // app-supplied controls here also keeps measurement and paint equal.
            let mut printable: String = grapheme
                .chars()
                .filter(|&c| printable_character(c))
                .collect();
            let natural = UnicodeWidthStr::width(printable.as_str());
            if natural == 0 && !printable.is_empty() {
                printable.insert(0, '◌');
            }
            let width = UnicodeWidthStr::width(printable.as_str());
            let spacing = (style.letter_spacing / self.metrics.width())
                .round()
                .max(0.0) as usize;
            let columns = attachment.map_or_else(
                || {
                    if width == 0 {
                        0
                    } else {
                        width.saturating_add(spacing)
                    }
                },
                |(_, width, _, _)| (width / self.metrics.width()).ceil() as usize,
            );
            clusters.push(Cluster {
                text: printable,
                start: utf16,
                end,
                style,
                columns,
                level: bidi.levels.get(byte).copied().unwrap_or_else(Level::ltr),
                paragraph_level: bidi
                    .paragraphs
                    .get(paragraph_index)
                    .map_or_else(Level::ltr, |p| p.level),
                break_after: breaks.get(break_index).is_some_and(|&(at, opportunity)| {
                    at == byte_end
                        && matches!(
                            opportunity,
                            BreakOpportunity::Allowed | BreakOpportunity::Mandatory
                        )
                }),
                whitespace: grapheme.chars().all(char::is_whitespace) && !newline,
                newline,
                tab,
                attachment,
            });
            utf16 = end;
        }
        PreparedText {
            clusters,
            align: text.align,
            max_lines: text.max_lines,
            ellipsize: text.ellipsize,
            no_wrap: text.no_wrap,
            rtl,
            attachment_count: text.attachments.len(),
            empty_style: text
                .spans
                .first()
                .map_or_else(ResolvedTextStyle::default, |s| s.style),
            shadow: text.shadow,
        }
    }

    fn measure(&self, prepared: &PreparedText, max_width: Option<Points>) -> Size<Points> {
        let max_columns = max_width.map_or(usize::MAX, |w| available_columns(w, self.metrics));
        let lines = prepared.break_lines(max_columns);
        let shown = prepared.shown_lines(lines.len());
        let mut width = Points::ZERO;
        let mut height = Points::ZERO;
        for (index, line) in lines.iter().take(shown).enumerate() {
            let pieces =
                prepared.visible_pieces(line, index + 1 == shown, shown < lines.len(), max_columns);
            width = width.max(columns(&pieces) as f32 * self.metrics.width());
            height += line_geometry(&pieces, prepared.empty_style, self.metrics).0;
        }
        Size::new(
            if prepared.no_wrap && prepared.max_lines == 0 {
                width
            } else {
                max_width.map_or(width, |max| width.min(max.max(Points::ZERO)))
            },
            height,
        )
    }

    fn layout(&self, prepared: &PreparedText, size: Size<Points>) -> TextLayout {
        let max_columns = available_columns(size.width, self.metrics);
        let lines = prepared.break_lines(max_columns);
        let shown = prepared.shown_lines(lines.len());
        let mut result = TerminalLayout {
            runs: Vec::with_capacity(
                prepared
                    .clusters
                    .len()
                    .min(shown.saturating_mul(max_columns)),
            ),
            lines: Vec::with_capacity(shown),
            attachments: vec![None; prepared.attachment_count],
            shadow: prepared.shadow,
            metrics: self.metrics,
        };
        let mut y = Points::ZERO;
        for (index, line) in lines.iter().take(shown).enumerate() {
            let pieces =
                prepared.visible_pieces(line, index + 1 == shown, shown < lines.len(), max_columns);
            let (height, baseline) = line_geometry(&pieces, prepared.empty_style, self.metrics);
            let mut width_columns = columns(&pieces);
            let free_columns = max_columns.saturating_sub(width_columns);
            let paragraph_level = prepared.clusters.get(line.start).map_or_else(
                || {
                    if prepared.rtl {
                        Level::rtl()
                    } else {
                        Level::ltr()
                    }
                },
                |c| c.paragraph_level,
            );
            let align = match prepared.align {
                TextAlign::Auto if paragraph_level.is_rtl() => TextAlign::Right,
                TextAlign::Auto => TextAlign::Left,
                align => align,
            };
            let x_column = match align {
                TextAlign::Center => free_columns / 2,
                TextAlign::Right => free_columns,
                _ => 0,
            };
            let x0 = x_column as f32 * self.metrics.width();
            let mut x = x0;
            let mut column = 0usize;
            let justify = align == TextAlign::Justify && index + 1 < shown && !line.forced;
            let gaps = if justify {
                pieces.iter().filter(|c| c.whitespace).count()
            } else {
                0
            };
            let mut remaining = free_columns;
            let mut gaps_left = gaps;
            let mut levels: Vec<_> = pieces.iter().map(|c| c.level).collect();
            for (piece, level) in pieces.iter().zip(levels.iter_mut()).rev() {
                if !piece.whitespace {
                    break;
                }
                *level = paragraph_level;
            }
            for i in BidiInfo::reorder_visual(&levels) {
                let piece = &pieces[i];
                let mut advance = piece.columns(column);
                if gaps_left > 0 && piece.whitespace {
                    let extra = remaining.div_ceil(gaps_left);
                    advance = advance.saturating_add(extra);
                    remaining -= extra;
                    gaps_left -= 1;
                    width_columns += extra;
                }
                if let Some((slot, _, _, attachment_ascent)) = piece.attachment {
                    result.attachments[slot] =
                        Some(Point::new(x, y + baseline - attachment_ascent));
                } else if !piece.text.is_empty() || piece.whitespace {
                    result.runs.push(TerminalRun {
                        x,
                        y: y + baseline - self.metrics.height(),
                        text: if piece.whitespace {
                            " ".repeat(advance)
                        } else if piece.level.is_rtl() {
                            mirror(&piece.text)
                        } else {
                            piece.text.clone()
                        },
                        style: piece.style,
                        width: if piece.whitespace {
                            advance.min(u16::MAX as usize) as u16
                        } else {
                            UnicodeWidthStr::width(piece.text.as_str()).min(u16::MAX as usize)
                                as u16
                        },
                        start: piece.start,
                        end: piece.end,
                        rtl: levels[i].is_rtl(),
                    });
                }
                column = column.saturating_add(advance);
                x += advance as f32 * self.metrics.width();
            }
            let start = prepared.clusters.get(line.start).map_or_else(
                || prepared.clusters.last().map_or(0, |c| c.end),
                |c| c.start,
            );
            result.lines.push(TextLine {
                text: String::new(),
                start,
                end: if line.end > line.start {
                    prepared.clusters[line.end - 1].end
                } else {
                    start
                },
                x: x0,
                y,
                width: width_columns as f32 * self.metrics.width(),
                height,
                ascender: baseline,
                descender: height - baseline,
                cap_height: self.metrics.height() * 0.7,
                x_height: self.metrics.height() * 0.5,
            });
            y += height;
        }
        TextLayout(Arc::new(result))
    }

    fn lines(&self, layout: &TextLayout) -> Vec<TextLine> {
        layout
            .downcast::<TerminalLayout>()
            .map_or_else(Vec::new, |l| l.lines.clone())
    }

    fn attachments(&self, layout: &TextLayout) -> Vec<Option<Point<Points>>> {
        layout
            .downcast::<TerminalLayout>()
            .map_or_else(Vec::new, |l| l.attachments.clone())
    }

    fn register_font(&self, data: &[u8]) -> Result<(), String> {
        self.fonts.register(data)
    }

    fn measure_canvas(&self, font: &nsh_core::canvas::CanvasFont, text: &str) -> Option<Points> {
        Some(self.fonts.measure(font, text))
    }
}

/// Rasterizes positioned terminal glyphs for transformed/effected scene groups.
/// Cell positions remain identical to ordinary terminal text; actual outlines
/// use this surface's registered fonts and fit within the measured cell boxes.
pub(crate) fn rasterize(
    layout: &TextLayout,
    width: Points,
    height: Points,
    fonts: &FontCatalog,
) -> Result<Raster, String> {
    let mut pixmap = raster_pixmap(width.0, height.0)?;
    let Some(layout) = layout.downcast::<TerminalLayout>() else {
        return Ok(Raster::from_pixmap(pixmap));
    };
    if let Some(shadow) = layout.shadow
        && !shadow.color.is_transparent()
    {
        let mut mask = raster_pixmap(width.0, height.0)?;
        for run in &layout.runs {
            let mut style = run.style;
            style.color = nsh_core::Color::rgba(255, 255, 255, (style.color.0 & 255) as u8);
            paint_raster_run(
                &mut mask,
                run.x.0,
                run.y.0,
                run.width as f32 * layout.metrics.width().0,
                layout.metrics.height().0,
                &run.text,
                style,
                fonts,
            );
        }
        let mut alpha: Vec<_> = mask.pixels().iter().map(|pixel| pixel.alpha()).collect();
        let radius = shadow.radius.0.clamp(0.0, 256.0);
        if radius > 0.0 {
            crate::canvas::blur(
                &mut alpha,
                mask.width() as usize,
                mask.height() as usize,
                radius as f64 / 2.0,
            );
        }
        let (r, g, b, a) = shadow.color.to_f64();
        for (pixel, alpha) in mask.pixels_mut().iter_mut().zip(alpha) {
            *pixel = tiny_skia::ColorU8::from_rgba(
                (r * 255.0).round() as u8,
                (g * 255.0).round() as u8,
                (b * 255.0).round() as u8,
                (alpha as f64 * a).round() as u8,
            )
            .premultiply();
        }
        pixmap.draw_pixmap(
            0,
            0,
            mask.as_ref(),
            &tiny_skia::PixmapPaint::default(),
            tiny_skia::Transform::from_translate(shadow.offset_x.0, shadow.offset_y.0),
            None,
        );
    }
    for run in &layout.runs {
        paint_raster_run(
            &mut pixmap,
            run.x.0,
            run.y.0,
            run.width as f32 * layout.metrics.width().0,
            layout.metrics.height().0,
            &run.text,
            run.style,
            fonts,
        );
    }
    Ok(Raster::from_pixmap(pixmap))
}

/// Captures terminal cells as pixels on a graphics worker. Reset backgrounds
/// are transparent so embedded controls retain the scene's underlying fill.
pub(crate) fn rasterize_cells(
    buffer: &Buffer,
    metrics: CellMetrics,
    fonts: &FontCatalog,
) -> Result<Raster, String> {
    let size = metrics.viewport(buffer.area.width, buffer.area.height);
    let mut pixmap = raster_pixmap(size.width.0, size.height.0)?;
    let mut block_path = tiny_skia::PathBuilder::new();
    for y in buffer.area.y..buffer.area.bottom() {
        for x in buffer.area.x..buffer.area.right() {
            let cell = &buffer[(x, y)];
            let background = if cell.modifier.contains(Modifier::REVERSED) {
                terminal_color(cell.fg, false)
            } else {
                terminal_color(cell.bg, true)
            };
            fill_raster_rect(
                &mut pixmap,
                (x - buffer.area.x) as f32 * metrics.width().0,
                (y - buffer.area.y) as f32 * metrics.height().0,
                metrics.width().0,
                metrics.height().0,
                background,
            );
        }
    }
    for y in buffer.area.y..buffer.area.bottom() {
        for x in buffer.area.x..buffer.area.right() {
            let cell = &buffer[(x, y)];
            if cell.modifier.contains(Modifier::HIDDEN) {
                continue;
            }
            let text: String = cell
                .symbol()
                .chars()
                .filter(|&c| printable_character(c))
                .collect();
            let columns = UnicodeWidthStr::width(text.as_str());
            if columns == 0 {
                continue;
            }
            let color = if cell.modifier.contains(Modifier::REVERSED) {
                terminal_color(cell.bg, false)
            } else {
                terminal_color(cell.fg, false)
            };
            let (px, py) = (
                (x - buffer.area.x) as f32 * metrics.width().0,
                (y - buffer.area.y) as f32 * metrics.height().0,
            );
            let mut style = ResolvedTextStyle {
                color,
                font_size: metrics.height() * 0.875,
                font_weight: if cell.modifier.contains(Modifier::BOLD) {
                    700
                } else {
                    400
                },
                italic: cell.modifier.contains(Modifier::ITALIC),
                ..Default::default()
            };
            if cell.modifier.contains(Modifier::DIM) {
                style.color.0 = (style.color.0 & !255) | 128;
            }
            style.decoration.underline = cell.modifier.contains(Modifier::UNDERLINED);
            style.decoration.line_through = cell.modifier.contains(Modifier::CROSSED_OUT);
            // Image blocks represent filled pixels, independent of font glyphs.
            if let Some(mask) = crate::image::block_mask(&text) {
                // Keep rectangular masks whole: independently antialiasing
                // touching pieces would leave seams at fractional cell sizes.
                let rectangle = match mask {
                    1 => Some((0.0, 0.0, 0.5, 0.5)),
                    2 => Some((0.5, 0.0, 0.5, 0.5)),
                    3 => Some((0.0, 0.0, 1.0, 0.5)),
                    4 => Some((0.0, 0.5, 0.5, 0.5)),
                    8 => Some((0.5, 0.5, 0.5, 0.5)),
                    12 => Some((0.0, 0.5, 1.0, 0.5)),
                    5 => Some((0.0, 0.0, 0.5, 1.0)),
                    10 => Some((0.5, 0.0, 0.5, 1.0)),
                    15 => Some((0.0, 0.0, 1.0, 1.0)),
                    _ => None,
                };
                if let Some((x, y, width, height)) = rectangle {
                    fill_raster_rect(
                        &mut pixmap,
                        px + x * metrics.width().0,
                        py + y * metrics.height().0,
                        width * metrics.width().0,
                        height * metrics.height().0,
                        style.color,
                    );
                } else {
                    for q in 0..4 {
                        if mask & (1 << q) != 0
                            && let Some(rect) = tiny_skia::Rect::from_xywh(
                                px + (q % 2) as f32 * metrics.width().0 / 2.0,
                                py + (q / 2) as f32 * metrics.height().0 / 2.0,
                                metrics.width().0 / 2.0,
                                metrics.height().0 / 2.0,
                            )
                        {
                            block_path.push_rect(rect);
                        }
                    }
                    if let Some(path) = block_path.finish() {
                        let c = style.color.0;
                        let mut paint = tiny_skia::Paint::default();
                        paint.set_color_rgba8(
                            (c >> 24) as u8,
                            (c >> 16) as u8,
                            (c >> 8) as u8,
                            c as u8,
                        );
                        pixmap.fill_path(
                            &path,
                            &paint,
                            tiny_skia::FillRule::Winding,
                            tiny_skia::Transform::identity(),
                            None,
                        );
                        block_path = path.clear();
                    } else {
                        block_path = tiny_skia::PathBuilder::new();
                    }
                }
            } else {
                paint_raster_run(
                    &mut pixmap,
                    px,
                    py,
                    columns as f32 * metrics.width().0,
                    metrics.height().0,
                    &text,
                    style,
                    fonts,
                );
            }
        }
    }
    Ok(Raster::from_pixmap(pixmap))
}

fn raster_pixmap(width: f32, height: f32) -> Result<tiny_skia::Pixmap, String> {
    if !width.is_finite()
        || !height.is_finite()
        || width <= 0.0
        || height <= 0.0
        || width > 8192.0
        || height > 8192.0
        || width.ceil() as u64 * height.ceil() as u64 > 8 << 20
    {
        return Err(
            "terminal glyph raster exceeds the finite 8192-side, 8-million-pixel limit".to_owned(),
        );
    }
    tiny_skia::Pixmap::new(width.ceil() as u32, height.ceil() as u32)
        .ok_or_else(|| "terminal glyph raster allocation failed".to_owned())
}

#[allow(clippy::too_many_arguments)]
fn paint_raster_run(
    pixmap: &mut tiny_skia::Pixmap,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    text: &str,
    style: ResolvedTextStyle,
    fonts: &FontCatalog,
) {
    if style.color.is_transparent() || text.is_empty() || width <= 0.0 || height <= 0.0 {
        return;
    }
    if text.chars().all(char::is_whitespace)
        && !style.decoration.underline
        && !style.decoration.line_through
    {
        return;
    }
    let font = nsh_core::canvas::CanvasFont {
        size: style.font_size,
        weight: style.font_weight,
        italic: style.italic,
        family: style.font_family.map(|family| family.name()),
        variant: style.font_variant,
    };
    let shaped = fonts.shape(&font, text);
    let natural_height = shaped.ascent + shaped.descent;
    let scale = if shaped.width > 0.0 && natural_height > 0.0 {
        (width / shaped.width).min(height / natural_height).min(1.0)
    } else {
        1.0
    };
    let baseline = y + (height - natural_height * scale) / 2.0 + shaped.ascent * scale;
    let transform = tiny_skia::Transform::from_row(
        scale,
        0.0,
        0.0,
        scale,
        x + (width - shaped.width * scale) / 2.0,
        baseline,
    );
    for glyph in shaped.paints() {
        match glyph {
            GlyphPaint::Path(path, color) => {
                let mut paint = tiny_skia::Paint::default();
                let c = color.map_or(style.color.0, |color| {
                    (color.0 & !255) | ((color.0 & 255) * (style.color.0 & 255) / 255)
                });
                paint.set_color_rgba8((c >> 24) as u8, (c >> 16) as u8, (c >> 8) as u8, c as u8);
                pixmap.fill_path(&path, &paint, tiny_skia::FillRule::Winding, transform, None);
            }
            GlyphPaint::Image {
                image,
                transform: placement,
                tint,
            } => {
                let image = if tint {
                    Arc::new(tint_bitmap(&image, style.color))
                } else {
                    image
                };
                let paint = tiny_skia::PixmapPaint {
                    opacity: if tint {
                        1.0
                    } else {
                        (style.color.0 & 255) as f32 / 255.0
                    },
                    quality: tiny_skia::FilterQuality::Bicubic,
                    ..Default::default()
                };
                pixmap.draw_pixmap(
                    0,
                    0,
                    image.as_ref().as_ref(),
                    &paint,
                    transform.pre_concat(placement),
                    None,
                );
            }
        }
    }
    let decoration = style.decoration_color.unwrap_or(style.color);
    let thickness = style.decoration_thickness.unwrap_or(px(1.0)).0.max(0.5);
    if style.decoration.underline {
        fill_raster_rect(
            pixmap,
            x,
            (baseline + style.underline_offset.unwrap_or(px(1.0)).0).min(y + height - thickness),
            width,
            thickness,
            decoration,
        );
    }
    if style.decoration.line_through {
        fill_raster_rect(
            pixmap,
            x,
            baseline - shaped.ascent * scale * 0.35,
            width,
            thickness,
            decoration,
        );
    }
}

fn fill_raster_rect(
    pixmap: &mut tiny_skia::Pixmap,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    color: nsh_core::Color,
) {
    if color.is_transparent() {
        return;
    }
    let Some(rect) = tiny_skia::Rect::from_xywh(x, y, width, height) else {
        return;
    };
    let mut paint = tiny_skia::Paint::default();
    let c = color.0;
    paint.set_color_rgba8((c >> 24) as u8, (c >> 16) as u8, (c >> 8) as u8, c as u8);
    pixmap.fill_rect(rect, &paint, tiny_skia::Transform::identity(), None);
}

fn terminal_color(color: TerminalColor, transparent_reset: bool) -> nsh_core::Color {
    let rgb = match color {
        TerminalColor::Reset if transparent_reset => return nsh_core::Color::TRANSPARENT,
        TerminalColor::Reset | TerminalColor::Black => [0, 0, 0],
        TerminalColor::Red => [128, 0, 0],
        TerminalColor::Green => [0, 128, 0],
        TerminalColor::Yellow => [128, 128, 0],
        TerminalColor::Blue => [0, 0, 128],
        TerminalColor::Magenta => [128, 0, 128],
        TerminalColor::Cyan => [0, 128, 128],
        TerminalColor::Gray => [192, 192, 192],
        TerminalColor::DarkGray => [128, 128, 128],
        TerminalColor::LightRed => [255, 0, 0],
        TerminalColor::LightGreen => [0, 255, 0],
        TerminalColor::LightYellow => [255, 255, 0],
        TerminalColor::LightBlue => [0, 0, 255],
        TerminalColor::LightMagenta => [255, 0, 255],
        TerminalColor::LightCyan => [0, 255, 255],
        TerminalColor::White => [255, 255, 255],
        TerminalColor::Rgb(r, g, b) => [r, g, b],
        TerminalColor::Indexed(index) => {
            const ANSI: [[u8; 3]; 16] = [
                [0, 0, 0],
                [128, 0, 0],
                [0, 128, 0],
                [128, 128, 0],
                [0, 0, 128],
                [128, 0, 128],
                [0, 128, 128],
                [192, 192, 192],
                [128, 128, 128],
                [255, 0, 0],
                [0, 255, 0],
                [255, 255, 0],
                [0, 0, 255],
                [255, 0, 255],
                [0, 255, 255],
                [255, 255, 255],
            ];
            if index < 16 {
                ANSI[index as usize]
            } else if index >= 232 {
                [8 + (index - 232) * 10; 3]
            } else {
                let cube = index - 16;
                let channel = |v: u8| if v == 0 { 0 } else { 55 + v * 40 };
                [channel(cube / 36), channel(cube / 6 % 6), channel(cube % 6)]
            }
        }
    };
    nsh_core::Color::rgba(rgb[0], rgb[1], rgb[2], 255)
}

fn ellipsize(
    pieces: &mut Vec<Cluster>,
    max_columns: usize,
    mode: EllipsizeMode,
    fallback: ResolvedTextStyle,
) {
    let style = pieces.last().map_or(fallback, |c| c.style);
    let at = pieces.first().map_or(0, |c| c.start);
    let ellipsis = Cluster {
        text: "…".to_owned(),
        start: at,
        end: at,
        style,
        columns: 1,
        level: pieces.first().map_or_else(Level::ltr, |c| c.level),
        paragraph_level: pieces
            .first()
            .map_or_else(Level::ltr, |c| c.paragraph_level),
        break_after: false,
        whitespace: false,
        newline: false,
        tab: false,
        attachment: None,
    };
    if max_columns == 0 {
        pieces.clear();
        return;
    }
    let budget = max_columns - 1;
    match mode {
        EllipsizeMode::Head => {
            let mut start = pieces.len();
            let mut width = 0usize;
            while start > 0 && width.saturating_add(pieces[start - 1].columns(width)) <= budget {
                start -= 1;
                width += pieces[start].columns(width);
            }
            pieces.drain(..start);
            pieces.insert(0, ellipsis);
        }
        EllipsizeMode::Middle => {
            let mut prefix = 0;
            let mut prefix_width = 0usize;
            let prefix_budget = budget.div_ceil(2);
            while prefix < pieces.len()
                && prefix_width.saturating_add(pieces[prefix].columns(prefix_width))
                    <= prefix_budget
            {
                prefix_width += pieces[prefix].columns(prefix_width);
                prefix += 1;
            }
            let mut suffix = pieces.len();
            let mut width = prefix_width;
            while suffix > prefix
                && width.saturating_add(pieces[suffix - 1].columns(width)) <= budget
            {
                suffix -= 1;
                width += pieces[suffix].columns(width);
            }
            pieces.splice(prefix..suffix, [ellipsis]);
        }
        EllipsizeMode::Tail | EllipsizeMode::Clip => {
            let mut end = 0;
            let mut width = 0usize;
            while end < pieces.len() && width.saturating_add(pieces[end].columns(width)) <= budget {
                width += pieces[end].columns(width);
                end += 1;
            }
            while end > 0 && pieces[end - 1].whitespace {
                end -= 1;
            }
            pieces.truncate(end);
            pieces.push(ellipsis);
        }
    }
}

fn mirror(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '(' => ')',
            ')' => '(',
            '[' => ']',
            ']' => '[',
            '{' => '}',
            '}' => '{',
            '<' => '>',
            '>' => '<',
            '«' => '»',
            '»' => '«',
            '‹' => '›',
            '›' => '‹',
            _ => c,
        })
        .collect()
}

/// Resolves the font attributes represented by terminal cells.
pub(crate) fn style_for_terminal(style: ResolvedTextStyle) -> Style {
    let color = style.color.0;
    let mut result = Style::default()
        .remove_modifier(
            Modifier::BOLD | Modifier::ITALIC | Modifier::UNDERLINED | Modifier::CROSSED_OUT,
        )
        .fg(TerminalColor::Rgb(
            (color >> 24) as u8,
            (color >> 16) as u8,
            (color >> 8) as u8,
        ));
    if style.font_weight >= 600 {
        result = result.add_modifier(Modifier::BOLD);
    }
    if style.italic {
        result = result.add_modifier(Modifier::ITALIC);
    }
    if style.decoration.underline {
        result = result.add_modifier(Modifier::UNDERLINED);
    }
    if style.decoration.line_through {
        result = result.add_modifier(Modifier::CROSSED_OUT);
    }
    result
}

/// Draws an already measured layout inside a point clip and an embedded cell area.
pub(crate) fn render_text(
    layout: &TextLayout,
    origin: Point<Points>,
    clip: Bounds<Points>,
    opacity: f32,
    metrics: CellMetrics,
    area: CellRect,
    buf: &mut Buffer,
) {
    render_text_filtered(
        layout, origin, clip, opacity, None, None, metrics, area, buf,
    );
}

/// Draws laid-out text after applying a composed shared color-filter matrix.
#[allow(clippy::too_many_arguments)]
pub(crate) fn render_text_filtered(
    layout: &TextLayout,
    origin: Point<Points>,
    clip: Bounds<Points>,
    opacity: f32,
    foreground: Option<nsh_core::Color>,
    filter: Option<&[f32; 20]>,
    metrics: CellMetrics,
    area: CellRect,
    buf: &mut Buffer,
) {
    let Some(layout) = layout.downcast::<TerminalLayout>() else {
        return;
    };
    if let Some(shadow) = layout.shadow {
        // The finite cell kernel preserves shadow offsets and soft edges while
        // bounding redraw cost for very large app-supplied blur radii.
        let radius = shadow.radius.max(Points::ZERO);
        let columns = (radius / metrics.width()).ceil().min(4.0) as i32;
        let rows = (radius / metrics.height()).ceil().min(4.0) as i32;
        let softness = 1.0 / (1.0 + radius / metrics.height());
        for row in -rows..=rows {
            for column in -columns..=columns {
                let dx = column as f32 * metrics.width();
                let dy = row as f32 * metrics.height();
                let distance = px(dx.0.hypot(dy.0));
                if distance > radius && (row != 0 || column != 0) {
                    continue;
                }
                let fade = if radius > Points::ZERO {
                    (-distance / radius * 2.0).exp()
                } else {
                    1.0
                };
                paint_runs(
                    layout
                        .runs
                        .iter()
                        .map(|run| (run, filter_color(shadow.color, filter))),
                    Point::new(
                        origin.x + shadow.offset_x + dx,
                        origin.y + shadow.offset_y + dy,
                    ),
                    clip,
                    opacity * softness * fade,
                    metrics,
                    area,
                    buf,
                );
            }
        }
    }
    paint_runs(
        layout.runs.iter().map(|run| {
            (
                run,
                filter_color(foreground.unwrap_or(run.style.color), filter),
            )
        }),
        origin,
        clip,
        opacity,
        metrics,
        area,
        buf,
    );
}

/// Applies the shared sRGB, row-major 4×5 filter representation to one color.
pub(crate) fn filter_color(color: nsh_core::Color, matrix: Option<&[f32; 20]>) -> nsh_core::Color {
    let Some(matrix) = matrix else {
        return color;
    };
    let (r, g, b, a) = color.to_f64();
    let input = [r as f32, g as f32, b as f32, a as f32];
    let output: [u8; 4] = std::array::from_fn(|row| {
        let start = row * 5;
        let value = input
            .iter()
            .enumerate()
            .map(|(column, channel)| matrix[start + column] * channel)
            .sum::<f32>()
            + matrix[start + 4];
        (value.clamp(0.0, 1.0) * 255.0).round() as u8
    });
    nsh_core::Color::rgba(output[0], output[1], output[2], output[3])
}

fn paint_runs<'a>(
    runs: impl Iterator<Item = (&'a TerminalRun, nsh_core::Color)>,
    origin: Point<Points>,
    clip: Bounds<Points>,
    opacity: f32,
    metrics: CellMetrics,
    area: CellRect,
    buf: &mut Buffer,
) {
    let bounds = area.intersection(buf.area);
    for (run, color) in runs {
        if color.is_transparent() || run.width == 0 {
            continue;
        }
        let px = origin.x + run.x;
        let py = origin.y + run.y;
        // Native mouse input resolves a cell's center. Keep visible text and
        // its clipping in those same cells, including fractional layout origins.
        let column = metrics.column_at(px) as i32;
        let row = metrics.row_at(py) as i32;
        let x = area.x as i32 + column;
        let y = area.y as i32 + row;
        if column < metrics.column_at(clip.origin.x) as i32
            || row < metrics.row_at(clip.origin.y) as i32
            || row >= metrics.row_at(clip.origin.y + clip.size.height) as i32
            || column + run.width as i32 > metrics.column_at(clip.origin.x + clip.size.width) as i32
            || x < bounds.x as i32
            || y < bounds.y as i32
            || y >= bounds.bottom() as i32
            || x + run.width as i32 > bounds.right() as i32
        {
            continue;
        }
        let mut run_style = run.style;
        run_style.color = color;
        let mut style = style_for_terminal(run_style);
        let alpha = (color.0 & 0xff) as f32 / 255.0 * opacity.clamp(0.0, 1.0);
        if alpha <= 0.0 {
            continue;
        }
        if alpha < 1.0
            && let TerminalColor::Rgb(red, green, blue) = buf[(x as u16, y as u16)].bg
        {
            let foreground = color.0;
            let blend = |channel: u8, background: u8| {
                (channel as f32 * alpha + background as f32 * (1.0 - alpha)).round() as u8
            };
            style.fg = Some(TerminalColor::Rgb(
                blend((foreground >> 24) as u8, red),
                blend((foreground >> 16) as u8, green),
                blend((foreground >> 8) as u8, blue),
            ));
        }
        // set_stringn also clears the continuation cell of wide graphemes.
        buf.set_stringn(x as u16, y as u16, &run.text, run.width as usize, style);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> AttributedText {
        let mut text = AttributedText::default();
        text.push(value, ResolvedTextStyle::default());
        text
    }

    fn layout(value: &AttributedText, columns: u16) -> (TerminalTextEngine, TextLayout) {
        let engine = TerminalTextEngine::default();
        let prepared = engine.prepare(value);
        let result = engine.layout(&prepared, Size::new(px(columns as f32 * 8.0), px(1000.0)));
        (engine, result)
    }

    fn rendered(layout: &TextLayout) -> String {
        layout
            .downcast::<TerminalLayout>()
            .unwrap()
            .runs
            .iter()
            .map(|r| r.text.as_str())
            .collect()
    }

    #[test]
    fn widths_and_utf16_ranges_follow_whole_graphemes() {
        let engine = TerminalTextEngine::default();
        let value = text("A中👩‍💻e\u{301}");
        let prepared = engine.prepare(&value);
        assert_eq!(
            engine.measure(&prepared, None),
            Size::new(px(48.0), px(16.0))
        );
        let result = engine.layout(&prepared, Size::new(px(48.0), px(16.0)));
        let runs = &result.downcast::<TerminalLayout>().unwrap().runs;
        assert_eq!(
            runs.iter().map(|r| r.width).collect::<Vec<_>>(),
            [1, 2, 2, 1]
        );
        assert_eq!(
            runs.iter().map(|r| (r.start, r.end)).collect::<Vec<_>>(),
            [(0, 1), (1, 2), (2, 7), (7, 9)]
        );
    }

    #[test]
    fn registered_fonts_change_canvas_advances_without_changing_terminal_cells() {
        let fonts = FontCatalog::default();
        let engine = TerminalTextEngine::with_fonts(CellMetrics::default(), fonts.clone());
        let value = text("WWW");
        let before = engine.measure(&engine.prepare(&value), None);
        engine
            .register_font(include_bytes!(
                "../../../tests/compat/cases/layout/fonts/Pacifico-Regular.ttf"
            ))
            .unwrap();
        assert_eq!(engine.measure(&engine.prepare(&value), None), before);
        assert_eq!(before.width, px(24.0));
        let font = nsh_core::canvas::CanvasFont::parse("24px Pacifico").unwrap();
        let width = nsh_core::canvas::measure_line(&engine, &font, "WWW");
        assert_eq!(width, px(fonts.shape(&font, "WWW").width));
        assert!((width - before.width).abs() > px(1.0));
        let metrics = nsh_core::canvas::line_metrics(&engine, &font, "WWW");
        assert_eq!(metrics.width, width);
        for text in [" ", "WWW ", "名字　"] {
            let expected = fonts.measure(&font, text);
            assert_eq!(
                nsh_core::canvas::measure_line(&engine, &font, text),
                expected
            );
            assert_eq!(
                nsh_core::canvas::line_metrics(&engine, &font, text).width,
                expected
            );
        }
        assert_eq!(
            nsh_core::canvas::line_metrics(&engine, &font, "").width,
            Points::ZERO
        );
    }

    #[test]
    fn rasterized_buffer_keeps_block_pixels_and_transparent_reset_backgrounds() {
        let metrics = CellMetrics::default();
        let mut buffer = Buffer::empty(CellRect::new(4, 3, 3, 1));
        buffer[(4, 3)]
            .set_symbol("▀")
            .set_fg(TerminalColor::Rgb(255, 0, 0))
            .set_bg(TerminalColor::Rgb(0, 0, 255));
        buffer[(5, 3)]
            .set_symbol("▚")
            .set_fg(TerminalColor::Rgb(255, 0, 0))
            .set_bg(TerminalColor::Rgb(0, 0, 255));
        let fonts = FontCatalog::default();
        let raster = rasterize_cells(&buffer, metrics, &fonts).unwrap();
        let pixel = |x: usize, y: usize| &raster.rgba[(y * raster.width as usize + x) * 4..][..4];
        assert_eq!((raster.width, raster.height), (24, 16));
        assert_eq!(pixel(2, 2), [255, 0, 0, 255]);
        assert_eq!(pixel(2, 12), [0, 0, 255, 255]);
        assert_eq!(pixel(10, 2), [255, 0, 0, 255]);
        assert_eq!(pixel(14, 2), [0, 0, 255, 255]);
        assert_eq!(pixel(10, 12), [0, 0, 255, 255]);
        assert_eq!(pixel(14, 12), [255, 0, 0, 255]);
        assert_eq!(pixel(20, 2), [0, 0, 0, 0]);

        for (symbol, x, y) in [("▀", 3, 2), ("█", 3, 7), ("▌", 1, 7), ("▛", 1, 7)] {
            buffer[(4, 3)].set_symbol(symbol);
            let raster = rasterize_cells(
                &buffer,
                CellMetrics::new(px(7.0), px(15.0)).unwrap(),
                &fonts,
            )
            .unwrap();
            let pixel = &raster.rgba[(y * raster.width as usize + x) * 4..][..4];
            assert_eq!(pixel, [255, 0, 0, 255], "no internal seam in {symbol}");
        }
    }

    #[test]
    fn unicode_wrap_and_empty_lines_preserve_ranges() {
        let (engine, result) = layout(&text("hello world\n中日\n"), 6);
        let lines = engine.lines(&result);
        assert_eq!(
            lines.iter().map(|l| (l.start, l.end)).collect::<Vec<_>>(),
            [(0, 6), (6, 11), (12, 14), (15, 15)]
        );
        assert_eq!(
            lines.iter().map(|l| l.y).collect::<Vec<_>>(),
            [px(0.0), px(16.0), px(32.0), px(48.0)]
        );
    }

    #[test]
    fn leading_empty_lines_have_empty_utf16_ranges() {
        let (engine, result) = layout(&text("\n\n中"), 4);
        assert_eq!(
            engine
                .lines(&result)
                .iter()
                .map(|line| (line.start, line.end))
                .collect::<Vec<_>>(),
            [(0, 0), (1, 1), (2, 3)]
        );
    }

    #[test]
    fn whitespace_at_an_exact_word_boundary_does_not_add_a_blank_line() {
        let (engine, result) = layout(&text("hello world"), 5);
        let lines = engine.lines(&result);
        assert_eq!(lines.len(), 2);
        assert_eq!(
            (lines[0].start, lines[0].end, lines[0].width),
            (0, 6, px(40.0))
        );
        assert_eq!((lines[1].start, lines[1].end), (6, 11));
    }

    #[test]
    fn ellipses_keep_the_requested_end_of_content() {
        for (mode, expected) in [
            (EllipsizeMode::Tail, "abc…"),
            (EllipsizeMode::Head, "…ghi"),
            (EllipsizeMode::Middle, "ab…i"),
            (EllipsizeMode::Clip, "abcd"),
        ] {
            let mut value = text("abcdefghi");
            value.max_lines = 1;
            value.ellipsize = mode;
            let (_, result) = layout(&value, 4);
            assert_eq!(rendered(&result), expected);
        }
    }

    #[test]
    fn intrinsic_measurement_includes_the_ellipsis_and_visible_suffix_height() {
        let engine = TerminalTextEngine::default();
        let mut value = text("a\nb");
        value.max_lines = 1;
        let prepared = engine.prepare(&value);
        for constraint in [None, Some(px(80.0))] {
            let measured = engine.measure(&prepared, constraint);
            assert_eq!(measured, Size::new(px(16.0), px(16.0)));
            let result = engine.layout(&prepared, measured);
            assert_eq!(rendered(&result), "a…");
            assert_eq!(engine.lines(&result)[0].width, measured.width);
        }
        for mode in [EllipsizeMode::Head, EllipsizeMode::Middle] {
            let mut value = text("abcd\n");
            value.push_attachment(Size::new(px(8.0), px(48.0)), ResolvedTextStyle::default());
            value.max_lines = 1;
            value.ellipsize = mode;
            let prepared = engine.prepare(&value);
            let measured = engine.measure(&prepared, Some(px(32.0)));
            assert_eq!(measured, Size::new(px(32.0), px(48.0)));
            let result = engine.layout(&prepared, measured);
            assert_eq!(engine.lines(&result)[0].height, measured.height);
            assert!(engine.attachments(&result)[0].is_some());
        }
    }

    #[test]
    fn attachments_keep_their_original_slots_after_truncation() {
        let mut value = text("ab");
        value.push_attachment(Size::new(px(16.0), px(16.0)), ResolvedTextStyle::default());
        value.push("cd", ResolvedTextStyle::default());
        value.push_attachment(Size::new(px(8.0), px(16.0)), ResolvedTextStyle::default());
        value.max_lines = 1;
        value.ellipsize = EllipsizeMode::Head;
        let (engine, result) = layout(&value, 4);
        let attachments = engine.attachments(&result);
        assert_eq!(attachments[0], None);
        assert!(attachments[1].is_some());
    }

    #[test]
    fn inline_attachments_share_the_text_baseline_in_whole_rows() {
        let engine = TerminalTextEngine::default();
        let mut value = text("a");
        value.push_attachment(Size::new(px(16.0), px(16.0)), ResolvedTextStyle::default());
        let prepared = engine.prepare(&value);
        assert_eq!(
            engine.measure(&prepared, None),
            Size::new(px(24.0), px(16.0))
        );
        let result = engine.layout(&prepared, Size::new(px(32.0), px(16.0)));
        assert_eq!(
            engine.attachments(&result),
            [Some(Point::new(px(8.0), px(0.0)))]
        );
        value.attachments[0].height = px(32.0);
        let (_, result) = layout(&value, 4);
        let result = result.downcast::<TerminalLayout>().unwrap();
        assert_eq!(result.attachments, [Some(Point::new(px(8.0), px(0.0)))]);
        assert_eq!(result.runs[0].y, px(16.0));
        assert_eq!(result.lines[0].height, px(32.0));
    }

    #[test]
    fn aligned_attachments_reserve_both_sides_of_the_terminal_baseline() {
        use nsh_core::VerticalAlign;

        let engine = TerminalTextEngine::default();
        for (align, attachment_height, expected_y, expected_height) in [
            (VerticalAlign::Baseline, 8.0, 8.0, 16.0),
            (VerticalAlign::TextTop, 8.0, 0.0, 16.0),
            (VerticalAlign::TextBottom, 8.0, 8.0, 16.0),
            (VerticalAlign::Middle, 16.0, 4.0, 32.0),
            (VerticalAlign::Baseline, 32.0, 0.0, 32.0),
            (VerticalAlign::TextTop, 32.0, 0.0, 32.0),
            (VerticalAlign::Middle, 32.0, 12.0, 48.0),
        ] {
            let mut value = text("a");
            let mut alignments = AttachmentAlignments::default();
            alignments.push(
                &mut value,
                Size::new(px(16.0), px(attachment_height)),
                align,
                ResolvedTextStyle::default(),
            );
            let prepared = engine.prepare_aligned(&value, &alignments);
            let measured = engine.measure(&prepared, None);
            assert_eq!(measured.height, px(expected_height), "{align:?}");
            let result = engine.layout(&prepared, measured);
            assert_eq!(
                engine.attachments(&result),
                [Some(Point::new(px(8.0), px(expected_y)))],
                "{align:?}",
            );
            assert!(px(expected_y + attachment_height) <= measured.height);
        }
    }

    #[test]
    fn alignment_and_bidi_use_cell_positions() {
        let mut value = text("אבג");
        value.align = TextAlign::Auto;
        let (_, result) = layout(&value, 5);
        let layout = result.downcast::<TerminalLayout>().unwrap();
        assert_eq!(rendered(&result), "גבא");
        assert_eq!(layout.runs[0].x, px(16.0));
    }

    #[test]
    fn auto_direction_is_resolved_for_each_paragraph() {
        let (_, result) = layout(&text("abc\nאבג"), 5);
        let layout = result.downcast::<TerminalLayout>().unwrap();
        assert_eq!(layout.lines[0].x, px(0.0));
        assert_eq!(layout.lines[1].x, px(16.0));
    }

    #[test]
    fn clipping_never_emits_half_a_wide_character_or_terminal_controls() {
        let (_, result) = layout(&text("\u{1b}[31m中x\u{07}"), 20);
        assert!(!rendered(&result).contains(char::is_control));
        let (_, result) = layout(&text("中x"), 3);
        let mut buffer = Buffer::empty(CellRect::new(4, 2, 6, 2));
        render_text(
            &result,
            Point::new(px(0.0), px(0.0)),
            Bounds::new(Point::new(px(8.0), px(0.0)), Size::new(px(16.0), px(16.0))),
            1.0,
            CellMetrics::default(),
            CellRect::new(4, 2, 6, 2),
            &mut buffer,
        );
        assert_eq!(buffer[(4, 2)].symbol(), " ");
        assert_eq!(buffer[(5, 2)].symbol(), " ");
        assert_eq!(buffer[(6, 2)].symbol(), "x");
    }

    #[test]
    fn fractional_padding_keeps_the_first_cell_and_restores_font_attributes() {
        let mut value = text("x");
        value.spans[0].style.color = nsh_core::Color::rgba(200, 100, 0, 128);
        let (_, result) = layout(&value, 1);
        let mut buffer = Buffer::empty(CellRect::new(0, 0, 3, 2));
        buffer[(1, 0)]
            .set_bg(TerminalColor::Rgb(0, 0, 0))
            .set_style(Style::default().add_modifier(Modifier::BOLD));
        render_text(
            &result,
            Point::new(px(12.0), px(0.0)),
            Bounds::new(Point::new(px(12.0), px(0.0)), Size::new(px(12.0), px(16.0))),
            1.0,
            CellMetrics::default(),
            buffer.area,
            &mut buffer,
        );
        assert_eq!(buffer[(1, 0)].symbol(), "x");
        assert_eq!(buffer[(1, 0)].fg, TerminalColor::Rgb(100, 50, 0));
        assert!(!buffer[(1, 0)].modifier.contains(Modifier::BOLD));

        let mut buffer = Buffer::empty(CellRect::new(0, 0, 4, 3));
        render_text(
            &result,
            Point::new(px(14.0), px(12.0)),
            Bounds::new(Point::new(px(14.0), px(12.0)), Size::new(px(8.0), px(16.0))),
            1.0,
            CellMetrics::default(),
            buffer.area,
            &mut buffer,
        );
        assert_eq!(buffer[(2, 1)].symbol(), "x");
        assert_eq!(buffer[(1, 0)].symbol(), " ");
    }

    #[test]
    fn text_shadows_draw_before_foreground_at_their_point_offset() {
        let mut value = text("x");
        value.shadow = Some(TextShadow {
            color: nsh_core::Color::rgba(0, 0, 255, 255),
            offset_x: px(8.0),
            offset_y: px(0.0),
            radius: px(0.0),
        });
        let (_, result) = layout(&value, 3);
        let mut buffer = Buffer::empty(CellRect::new(0, 0, 3, 1));
        render_text(
            &result,
            Point::new(px(0.0), px(0.0)),
            Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(24.0), px(16.0))),
            1.0,
            CellMetrics::default(),
            buffer.area,
            &mut buffer,
        );
        assert_eq!(buffer[(0, 0)].symbol(), "x");
        assert_eq!(buffer[(0, 0)].fg, TerminalColor::Rgb(0, 0, 0));
        assert_eq!(buffer[(1, 0)].symbol(), "x");
        assert_eq!(buffer[(1, 0)].fg, TerminalColor::Rgb(0, 0, 255));
    }

    #[test]
    fn color_filters_apply_to_text_and_shadow_before_opacity() {
        let mut value = text("x");
        value.spans[0].style.color = nsh_core::Color::rgba(255, 0, 0, 255);
        value.shadow = Some(TextShadow {
            color: nsh_core::Color::rgba(0, 0, 255, 255),
            offset_x: px(8.0),
            offset_y: px(0.0),
            radius: px(0.0),
        });
        let (_, result) = layout(&value, 3);
        let mut buffer = Buffer::empty(CellRect::new(0, 0, 3, 1));
        for cell in &mut buffer.content {
            cell.set_bg(TerminalColor::Rgb(0, 0, 0));
        }
        let filter = nsh_core::compose_color_matrices(&[nsh_core::Filter::Invert(1.0)]).unwrap();
        render_text_filtered(
            &result,
            Point::new(px(0.0), px(0.0)),
            Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(24.0), px(16.0))),
            0.5,
            None,
            Some(&filter),
            CellMetrics::default(),
            buffer.area,
            &mut buffer,
        );
        assert_eq!(buffer[(0, 0)].fg, TerminalColor::Rgb(0, 128, 128));
        assert_eq!(buffer[(1, 0)].fg, TerminalColor::Rgb(128, 128, 0));
    }

    #[test]
    fn styles_and_tabs_survive_layout_without_leaking_direction_controls() {
        let mut value = text("a\t");
        let style = ResolvedTextStyle {
            font_weight: 700,
            italic: true,
            ..Default::default()
        };
        value.push("中\u{202e}b", style);
        let (_, result) = layout(&value, 12);
        let runs = &result.downcast::<TerminalLayout>().unwrap().runs;
        assert_eq!(runs[1].text, "   ");
        let cjk = runs.iter().find(|run| run.text == "中").unwrap();
        assert_eq!(cjk.x, px(32.0));
        assert_eq!(cjk.style, style);
        assert!(!rendered(&result).contains('\u{202e}'));
    }

    #[test]
    fn zero_width_and_nowrap_measurements_are_bounded() {
        let engine = TerminalTextEngine::default();
        let value = text("中a\n");
        let prepared = engine.prepare(&value);
        assert_eq!(
            engine.measure(&prepared, Some(px(0.0))),
            Size::new(px(0.0), px(48.0))
        );
        let mut value = text("abcde");
        value.no_wrap = true;
        let prepared = engine.prepare(&value);
        assert_eq!(
            engine.measure(&prepared, Some(px(16.0))),
            Size::new(px(40.0), px(16.0))
        );
        let result = engine.layout(&prepared, Size::new(px(16.0), px(16.0)));
        assert_eq!(rendered(&result), "abcde");
        assert_eq!(engine.lines(&result)[0].width, px(40.0));
    }
}
