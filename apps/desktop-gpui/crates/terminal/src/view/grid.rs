/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! What a terminal's picture paints, worked out from its cells alone, with
//! no window: the backgrounds, the highlights (the selection and find's
//! matches), the text runs, the cells drawn as quads, and the cursor, all
//! in cells. The element turns them into pixels ([`super::element`]).
//!
//! Zed's terminal (GPL-3.0) informed the practice, not the code: adjacent
//! cells of one style make one run, shaped at a forced cell width so every
//! glyph lands on its column; a wide character is a run of its own, two
//! cells wide; zero-width characters ride on their cell; backgrounds are
//! separate rectangles merged along a row and down identical rows;
//! box-drawing and block characters are quads; themed text is raised to a
//! minimum contrast against its fill ([`shared::contrast`]).

use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor, Rgb};
use gpui_kit::Hsla;
use shared::contrast;
use shared::theme::TerminalPalette;

use super::box_drawing::{self, BoxGlyph};
use crate::{TerminalContent, TerminalMatch};

/// A rectangle of cells filled with one colour.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CellRect {
    pub row: usize,
    pub column: usize,
    pub columns: usize,
    pub rows: usize,
    pub color: Hsla,
}

/// How a run is underlined: the program's straight kinds (single, double,
/// dotted, dashed) draw as one straight line, a curly one as a wave.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Underline {
    Straight,
    Curly,
}

/// Adjacent cells of one row in one style, shaped as one run.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TextSpan {
    pub row: usize,
    pub column: usize,
    /// The cells it covers: one per character, two for a wide one.
    pub columns: usize,
    pub text: String,
    pub color: Hsla,
    pub bold: bool,
    pub italic: bool,
    pub underline: Option<Underline>,
    pub strikethrough: bool,
    /// One wide character over two cells, shaped alone.
    pub wide: bool,
}

/// A cell drawn as quads.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct GlyphCell {
    pub row: usize,
    pub column: usize,
    pub glyph: BoxGlyph,
    pub color: Hsla,
}

/// How the cursor is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CursorKind {
    /// A filled cell with its character drawn over it in the cell's fill.
    Block,
    Underline,
    Bar,
    /// The outline of a cell: the program asked for it, or the terminal
    /// does not have focus.
    Hollow,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CursorSpec {
    pub row: usize,
    pub column: usize,
    /// Two over a wide character.
    pub columns: usize,
    pub kind: CursorKind,
    pub color: Hsla,
    /// A block cursor's character, in the colour of the cell's fill.
    pub text: Option<TextSpan>,
}

/// Everything one picture paints, in painting order: backgrounds, then
/// highlights, then text and quads, then the cursor.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct GridLayout {
    pub backgrounds: Vec<CellRect>,
    pub highlights: Vec<CellRect>,
    pub spans: Vec<TextSpan>,
    pub glyphs: Vec<GlyphCell>,
    pub cursor: Option<CursorSpec>,
}

/// What a picture is painted with besides its cells.
pub(crate) struct GridStyle<'a> {
    pub palette: &'a TerminalPalette,
    /// The fills behind find's matches and its active match.
    pub find_match: Hsla,
    pub find_match_active: Hsla,
    pub focused: bool,
    /// Whether to draw the cursor at all (not over an exited picture).
    pub cursor: bool,
    /// The least APCA lightness contrast themed text is raised to
    /// ([`contrast::MINIMUM_CONTRAST`]; 0 leaves every colour as it is).
    pub minimum_contrast: f32,
    /// The cells of the link under the pointer while ⌘ is held, first and
    /// last, in grid coordinates: underlined.
    pub link: Option<(Point, Point)>,
}

/// The colours of a picture: the program's redefinitions over the
/// palette's.
struct Colours<'a> {
    palette: &'a TerminalPalette,
    overrides: &'a Colors,
}

/// A colour a program set as 24-bit RGB: data, painted as it is.
fn rgb(color: Rgb) -> Hsla {
    let channel = |value: u8| f32::from(value) / 255.;
    gpui_kit::Rgba { r: channel(color.r), g: channel(color.g), b: channel(color.b), a: 1. }.into()
}

impl Colours<'_> {
    fn named(&self, named: NamedColor) -> Hsla {
        if let Some(color) = self.overrides[named] {
            return rgb(color);
        }
        let palette = self.palette;
        let index = named as usize;
        match named {
            NamedColor::Foreground | NamedColor::BrightForeground => palette.foreground,
            NamedColor::Background => palette.background,
            NamedColor::Cursor => palette.cursor,
            NamedColor::DimForeground => self.dim(palette.foreground),
            NamedColor::DimBlack
            | NamedColor::DimRed
            | NamedColor::DimGreen
            | NamedColor::DimYellow
            | NamedColor::DimBlue
            | NamedColor::DimMagenta
            | NamedColor::DimCyan
            | NamedColor::DimWhite => self.dim(self.named(named.to_bright())),
            _ => palette.ansi[index.min(15)],
        }
    }

    fn resolve(&self, color: Color) -> Hsla {
        match color {
            Color::Named(named) => self.named(named),
            Color::Spec(spec) => rgb(spec),
            Color::Indexed(index) => match self.overrides[usize::from(index)] {
                Some(color) => rgb(color),
                None => self.palette.indexed(index),
            },
        }
    }

    /// A faint form of `color`: 60% of it over the fill.
    fn dim(&self, color: Hsla) -> Hsla {
        self.named(NamedColor::Background).blend(color.opacity(0.6))
    }

    /// Whether `color` (a cell's, faint when `dim`) is the palette's: the
    /// default ink or fill or one of the sixteen, not redefined by the
    /// program. A 24-bit colour, one of the 256 past the sixteen, or a
    /// redefined one is the program's choice.
    fn is_themed(&self, color: Color, dim: bool) -> bool {
        match color {
            Color::Named(named) => {
                self.overrides[named].is_none()
                    && !(dim && self.overrides[named.to_dim()].is_some())
            }
            Color::Indexed(index) => index < 16 && self.overrides[usize::from(index)].is_none(),
            Color::Spec(_) => false,
        }
    }

    /// A cell's ink and fill, with its inverse, faint and hidden flags, and
    /// whether the ink is the palette's (which may be raised for contrast;
    /// never a hidden cell's, which must match its fill).
    fn of(&self, cell: &Cell) -> (Hsla, Hsla, bool) {
        let dim = cell.flags.contains(Flags::DIM);
        let mut fg = match cell.fg {
            Color::Named(named) if dim => self.named(named.to_dim()),
            color if dim => self.dim(self.resolve(color)),
            color => self.resolve(color),
        };
        let mut bg = self.resolve(cell.bg);
        let mut themed = self.is_themed(cell.fg, dim);
        if cell.flags.contains(Flags::INVERSE) {
            std::mem::swap(&mut fg, &mut bg);
            themed = self.is_themed(cell.bg, false);
        }
        if cell.flags.contains(Flags::HIDDEN) {
            fg = bg;
            themed = false;
        }
        (fg, bg, themed)
    }
}

/// Characters drawn for their shape rather than read: box drawing, blocks,
/// geometric shapes, Braille patterns, Powerline's separators and the
/// legacy computing symbols. Their ink is never raised: a frame or a bar
/// keeps the colour it was given.
fn is_decorative(c: char) -> bool {
    matches!(
        u32::from(c),
        0x2500..=0x25FF | 0x2800..=0x28FF | 0xE0A0..=0xE0D7 | 0x1FB00..=0x1FBFF
    )
}

/// Themed ink raised to the minimum contrast, each pair worked out once
/// per picture.
struct Contrast {
    minimum: f32,
    raised: Vec<(Hsla, Hsla, Hsla)>,
}

impl Contrast {
    fn ink(&mut self, fg: Hsla, bg: Hsla) -> Hsla {
        if self.minimum <= 0. {
            return fg;
        }
        if let Some((_, _, raised)) =
            self.raised.iter().find(|(text, fill, _)| *text == fg && *fill == bg)
        {
            return *raised;
        }
        let raised = contrast::ensure_contrast(fg, bg, self.minimum);
        self.raised.push((fg, bg, raised));
        raised
    }
}

/// The style a run shares.
#[derive(Debug, Clone, Copy, PartialEq)]
struct RunStyle {
    color: Hsla,
    background: Hsla,
    bold: bool,
    italic: bool,
    underline: Option<Underline>,
    strikethrough: bool,
}

impl RunStyle {
    fn of(cell: &Cell, color: Hsla, background: Hsla) -> Self {
        let flags = cell.flags;
        let underline = if flags.contains(Flags::UNDERCURL) {
            Some(Underline::Curly)
        } else if flags.intersects(Flags::ALL_UNDERLINES) {
            Some(Underline::Straight)
        } else {
            None
        };
        Self {
            color,
            background,
            bold: flags.contains(Flags::BOLD),
            italic: flags.contains(Flags::ITALIC),
            underline,
            strikethrough: flags.contains(Flags::STRIKEOUT),
        }
    }

    fn decorated(&self) -> bool {
        self.underline.is_some() || self.strikethrough
    }

    fn span(
        &self,
        row: usize,
        column: usize,
        text: String,
        columns: usize,
        wide: bool,
    ) -> TextSpan {
        TextSpan {
            row,
            column,
            columns,
            text,
            color: self.color,
            bold: self.bold,
            italic: self.italic,
            underline: self.underline,
            strikethrough: self.strikethrough,
            wide,
        }
    }
}

/// A run being gathered along a row.
struct OpenRun {
    style: RunStyle,
    span: TextSpan,
    /// Blank, undecorated cells at its end, dropped when it closes.
    trailing_blanks: usize,
}

impl OpenRun {
    fn close(mut self) -> TextSpan {
        if self.trailing_blanks > 0 {
            let keep = self.span.text.chars().count() - self.trailing_blanks;
            self.span.text = self.span.text.chars().take(keep).collect();
            self.span.columns -= self.trailing_blanks;
        }
        self.span
    }
}

/// The text a cell shows: its character and the zero-width ones on it.
fn cell_text(cell: &Cell) -> String {
    let c = if cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) { ' ' } else { cell.c };
    let mut text = String::from(c);
    if let Some(zero_width) = cell.zerowidth() {
        text.extend(zero_width.iter());
    }
    text
}

/// Lays out `content` in cells, with find's `matches` highlighted (the one
/// at `active` in the stronger fill).
pub(crate) fn layout(
    content: &TerminalContent,
    style: &GridStyle,
    matches: &[TerminalMatch],
    active: Option<usize>,
) -> GridLayout {
    let colours = Colours { palette: style.palette, overrides: &content.colors };
    let default_background = colours.named(NamedColor::Background);
    let columns = usize::from(content.size.cols).max(1);
    let rows = content.cells.len() / columns;
    let mut out = GridLayout::default();
    let mut contrast = Contrast { minimum: style.minimum_contrast, raised: Vec::new() };
    let offset = i32::try_from(content.display_offset).unwrap_or(i32::MAX);
    let in_link = |row: usize, column: usize| {
        style.link.is_some_and(|(start, end)| {
            let point =
                Point::new(Line(i32::try_from(row).unwrap_or(i32::MAX) - offset), Column(column));
            start <= point && point <= end
        })
    };
    // Background rectangles still open downwards: those of the row above.
    let mut open: Vec<usize> = Vec::new();
    for (row, cells) in content.cells.chunks(columns).enumerate() {
        let mut row_rects: Vec<CellRect> = Vec::new();
        let mut run: Option<OpenRun> = None;
        for (column, indexed) in cells.iter().enumerate() {
            let cell = &indexed.cell;
            // The second half of a wide character, which covers it.
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let (fg, bg, themed) = colours.of(cell);
            let width = if cell.flags.contains(Flags::WIDE_CHAR) { 2 } else { 1 };
            if bg != default_background {
                match row_rects.last_mut() {
                    Some(last) if last.color == bg && last.column + last.columns == column => {
                        last.columns += width;
                    }
                    _ => {
                        row_rects.push(CellRect { row, column, columns: width, rows: 1, color: bg })
                    }
                }
            }
            let hidden = cell.flags.contains(Flags::HIDDEN);
            if let Some(glyph) = (!hidden).then(|| box_drawing::glyph(cell.c)).flatten() {
                out.spans.extend(run.take().map(OpenRun::close));
                out.glyphs.push(GlyphCell { row, column, glyph, color: fg });
                continue;
            }
            let ink = if themed && !is_decorative(cell.c) { contrast.ink(fg, bg) } else { fg };
            let mut run_style = RunStyle::of(cell, ink, bg);
            if in_link(row, column) {
                run_style.underline = Some(Underline::Straight);
            }
            let text = cell_text(cell);
            if width == 2 {
                out.spans.extend(run.take().map(OpenRun::close));
                if !hidden {
                    out.spans.push(run_style.span(row, column, text, 2, true));
                }
                continue;
            }
            let blank = hidden || (text == " " && !run_style.decorated());
            match run.as_mut() {
                Some(open)
                    if open.style == run_style
                        && open.span.column + open.span.columns == column =>
                {
                    open.span.text.push_str(&text);
                    open.span.columns += 1;
                    open.trailing_blanks = if blank { open.trailing_blanks + 1 } else { 0 };
                }
                _ => {
                    out.spans.extend(run.take().map(OpenRun::close));
                    if !blank {
                        run = Some(OpenRun {
                            style: run_style,
                            span: run_style.span(row, column, text, 1, false),
                            trailing_blanks: 0,
                        });
                    }
                }
            }
        }
        out.spans.extend(run.take().map(OpenRun::close));
        // Down identical rows: a rectangle of the row above with the same
        // columns and colour grows instead.
        let mut still_open = Vec::new();
        for rect in row_rects {
            let above = open.iter().copied().find(|&ix| {
                let candidate: &CellRect = &out.backgrounds[ix];
                candidate.column == rect.column
                    && candidate.columns == rect.columns
                    && candidate.color == rect.color
                    && candidate.row + candidate.rows == row
            });
            match above {
                Some(ix) => {
                    out.backgrounds[ix].rows += 1;
                    still_open.push(ix);
                }
                None => {
                    still_open.push(out.backgrounds.len());
                    out.backgrounds.push(rect);
                }
            }
        }
        open = still_open;
    }
    out.highlights = highlights(content, columns, rows, matches, active, style);
    out.cursor = cursor(content, columns, rows, &colours, style);
    out
}

/// The selection's cells and the matches', merged along each row.
fn highlights(
    content: &TerminalContent,
    columns: usize,
    rows: usize,
    matches: &[TerminalMatch],
    active: Option<usize>,
    style: &GridStyle,
) -> Vec<CellRect> {
    let offset = i32::try_from(content.display_offset).unwrap_or(i32::MAX);
    let line_of = |row: usize| Line(i32::try_from(row).unwrap_or(i32::MAX) - offset);
    let mut out: Vec<CellRect> = Vec::new();
    for (ix, found) in matches.iter().enumerate() {
        let color = if active == Some(ix) { style.find_match_active } else { style.find_match };
        for row in 0..rows {
            let line = line_of(row);
            if line < found.start.line || line > found.end.line {
                continue;
            }
            let first = if line == found.start.line { found.start.column.0 } else { 0 };
            let last = if line == found.end.line { found.end.column.0 } else { columns - 1 };
            if first <= last && first < columns {
                let last = last.min(columns - 1);
                out.push(CellRect {
                    row,
                    column: first,
                    columns: last - first + 1,
                    rows: 1,
                    color,
                });
            }
        }
    }
    if let Some(selection) = &content.selection {
        for row in 0..rows {
            let line = line_of(row);
            let mut start: Option<usize> = None;
            for column in 0..=columns {
                let selected =
                    column < columns && selection.contains(Point::new(line, Column(column)));
                match (selected, start) {
                    (true, None) => start = Some(column),
                    (false, Some(first)) => {
                        out.push(CellRect {
                            row,
                            column: first,
                            columns: column - first,
                            rows: 1,
                            color: style.palette.selection,
                        });
                        start = None;
                    }
                    _ => {}
                }
            }
        }
    }
    out
}

fn cursor(
    content: &TerminalContent,
    columns: usize,
    rows: usize,
    colours: &Colours,
    style: &GridStyle,
) -> Option<CursorSpec> {
    if !style.cursor || content.cursor.shape == CursorShape::Hidden {
        return None;
    }
    let row = usize::try_from(
        i64::from(content.cursor.point.line.0)
            + i64::try_from(content.display_offset).unwrap_or(i64::MAX),
    )
    .ok()
    .filter(|row| *row < rows)?;
    let column = content.cursor.point.column.0.min(columns - 1);
    let cell = &content.cells.get(row * columns + column)?.cell;
    let width = if cell.flags.contains(Flags::WIDE_CHAR) { 2 } else { 1 };
    let kind = if !style.focused {
        CursorKind::Hollow
    } else {
        match content.cursor.shape {
            CursorShape::Underline => CursorKind::Underline,
            CursorShape::Beam => CursorKind::Bar,
            CursorShape::HollowBlock => CursorKind::Hollow,
            _ => CursorKind::Block,
        }
    };
    let color = colours.named(NamedColor::Cursor);
    let text = (kind == CursorKind::Block && cell.c != ' ' && box_drawing::glyph(cell.c).is_none())
        .then(|| {
            let (fg, bg, _) = colours.of(cell);
            RunStyle { color: bg, ..RunStyle::of(cell, fg, bg) }.span(
                row,
                column,
                cell_text(cell),
                width,
                width == 2,
            )
        });
    Some(CursorSpec { row, column, columns: width, kind, color, text })
}

#[cfg(test)]
mod tests {
    use alacritty_terminal::index::{Column, Line, Point};
    use host_protocol::PtySize;
    use shared::palette::ThemePalette;
    use shared::theme::{MakaPalette, TerminalPalette};

    use super::*;
    use crate::emulator::Emulator;

    fn picture(text: &str) -> TerminalContent {
        let mut emulator = Emulator::new(PtySize::new(12, 4).expect("size"));
        emulator.advance(text);
        emulator.content()
    }

    fn palette() -> TerminalPalette {
        TerminalPalette::for_palette(ThemePalette::Default, gpui_kit::component::ThemeMode::Light)
    }

    fn lay_out(content: &TerminalContent, focused: bool) -> GridLayout {
        let palette = palette();
        let maka = MakaPalette::light();
        let style = GridStyle {
            palette: &palette,
            find_match: maka.find_match,
            find_match_active: maka.find_match_active,
            focused,
            cursor: true,
            minimum_contrast: 0.,
            link: None,
        };
        layout(content, &style, &[], None)
    }

    fn texts(layout: &GridLayout) -> Vec<(usize, usize, usize, &str)> {
        layout
            .spans
            .iter()
            .map(|span| (span.row, span.column, span.columns, span.text.as_str()))
            .collect()
    }

    #[test]
    fn adjacent_cells_of_one_style_make_one_run() {
        let layout =
            lay_out(&picture("\x1b[31mred\x1b[0m plain\r\n\x1b[1mbold\x1b[0m\r\nab cd"), true);
        assert_eq!(
            texts(&layout),
            [(0, 0, 3, "red"), (0, 4, 5, "plain"), (1, 0, 4, "bold"), (2, 0, 5, "ab cd")],
            "a style change starts a run, a blank inside one stays, a leading one is skipped"
        );
        assert_eq!(layout.spans[0].color, palette().ansi[1]);
        assert_eq!(layout.spans[1].color, palette().foreground);
        assert!(layout.spans[2].bold);
    }

    #[test]
    fn a_wide_character_is_its_own_run_over_two_cells() {
        let layout = lay_out(&picture("a中b"), true);
        assert_eq!(texts(&layout), [(0, 0, 1, "a"), (0, 1, 2, "中"), (0, 3, 1, "b")]);
        assert!(layout.spans[1].wide);
        // A combining mark rides on its cell.
        let layout = lay_out(&picture("e\u{301}x"), true);
        assert_eq!(texts(&layout), [(0, 0, 2, "e\u{301}x")]);
    }

    #[test]
    fn box_drawing_and_blocks_are_quads_not_text() {
        let layout = lay_out(&picture("┌─┐█x"), true);
        let glyph_columns: Vec<usize> = layout.glyphs.iter().map(|glyph| glyph.column).collect();
        assert_eq!(glyph_columns, [0, 1, 2, 3]);
        assert_eq!(texts(&layout), [(0, 4, 1, "x")]);
    }

    #[test]
    fn backgrounds_merge_along_rows_and_down_identical_ones_without_gaps() {
        let layout =
            lay_out(&picture("\x1b[44mab\x1b[0m\r\n\x1b[44mcd\x1b[0m\r\n\x1b[41me\x1b[42mf"), true);
        let blue = palette().ansi[4];
        assert_eq!(
            layout.backgrounds[0],
            CellRect { row: 0, column: 0, columns: 2, rows: 2, color: blue },
            "two identical rows are one rectangle"
        );
        let (red, green) = (&layout.backgrounds[1], &layout.backgrounds[2]);
        assert_eq!((red.row, red.column, red.columns), (2, 0, 1));
        assert_eq!(red.column + red.columns, green.column, "adjacent: no gap between them");
        // The default fill is the box's own: no rectangle for it.
        assert_eq!(layout.backgrounds.len(), 3);
    }

    #[test]
    fn the_cursor_takes_the_programs_shape_and_is_hollow_without_focus() {
        let kind = |text: &str, focused: bool| {
            lay_out(&picture(text), focused).cursor.map(|cursor| cursor.kind)
        };
        assert_eq!(kind("ab", true), Some(CursorKind::Block));
        assert_eq!(kind("ab\x1b[4 q", true), Some(CursorKind::Underline));
        assert_eq!(kind("ab\x1b[6 q", true), Some(CursorKind::Bar));
        assert_eq!(kind("ab", false), Some(CursorKind::Hollow));
        assert_eq!(kind("ab\x1b[6 q", false), Some(CursorKind::Hollow));
        assert_eq!(kind("ab\x1b[?25l", true), None);
        // A block cursor draws the character under it in the cell's fill.
        let cursor = lay_out(&picture("ab\x1b[D"), true).cursor.expect("cursor");
        assert_eq!((cursor.row, cursor.column), (0, 1));
        let text = cursor.text.expect("the character under it");
        assert_eq!((text.text.as_str(), text.color), ("b", palette().background));
        // Over a wide character it is two cells wide.
        let cursor = lay_out(&picture("中\x1b[D\x1b[D"), true).cursor.expect("cursor");
        assert_eq!(cursor.columns, 2);
    }

    fn lay_out_in(content: &TerminalContent, palette: &TerminalPalette) -> GridLayout {
        let maka = MakaPalette::light();
        let style = GridStyle {
            palette,
            find_match: maka.find_match,
            find_match_active: maka.find_match_active,
            focused: true,
            cursor: true,
            minimum_contrast: contrast::MINIMUM_CONTRAST,
            link: None,
        };
        layout(content, &style, &[], None)
    }

    fn span<'a>(layout: &'a GridLayout, text: &str) -> &'a TextSpan {
        layout.spans.iter().find(|span| span.text == text).unwrap_or_else(|| panic!("{text}"))
    }

    #[test]
    fn a_faint_default_ink_is_raised_and_a_programs_24_bit_colour_is_left_alone() {
        use gpui_kit::component::ThemeMode;
        // Tokyo Night's dark faint ink sits under the minimum on its fill.
        let palette = TerminalPalette::for_palette(ThemePalette::TokyoNight, ThemeMode::Dark);
        let faint = palette.background.blend(palette.foreground.opacity(0.6));
        let minimum = contrast::MINIMUM_CONTRAST;
        assert!(contrast::lightness_contrast(faint, palette.background).abs() < minimum);
        let content = picture("\x1b[2mfaint\x1b[0m \x1b[38;2;40;40;50mrgb\x1b[0m");
        let layout = lay_out_in(&content, &palette);
        let raised = span(&layout, "faint").color;
        assert_ne!(raised, faint);
        assert!(contrast::lightness_contrast(raised, palette.background).abs() >= minimum);
        let program = gpui_kit::Rgba { r: 40. / 255., g: 40. / 255., b: 50. / 255., a: 1. };
        assert_eq!(span(&layout, "rgb").color, Hsla::from(program), "the program's colour");
    }

    #[test]
    fn every_palette_keeps_its_themed_text_over_the_minimum_in_light_and_dark() {
        use gpui_kit::component::ThemeMode;
        let minimum = contrast::MINIMUM_CONTRAST;
        // The sixteen as SGR 30–37 and 90–97, the default ink and its faint
        // form, a colour of the 256, a decorative shape, and a block cursor
        // over faint text.
        let mut text = String::from("df \x1b[2mdim\x1b[0m");
        for code in (30..38).chain(90..98) {
            text.push_str(&format!(" \x1b[{code}mc{code}\x1b[0m"));
        }
        text.push_str(" \x1b[38;5;236mi236\x1b[0m \x1b[30m●\x1b[0m \x1b[2mx\x1b[D");
        let mut emulator = Emulator::new(PtySize::new(240, 2).expect("size"));
        emulator.advance(&text);
        let content = emulator.content();
        for palette in ThemePalette::ALL {
            for mode in [ThemeMode::Light, ThemeMode::Dark] {
                let colours = TerminalPalette::for_palette(palette, mode);
                let background = colours.background;
                let layout = lay_out_in(&content, &colours);
                let reads = |color: Hsla| contrast::lightness_contrast(color, background).abs();
                let mut themed = vec![
                    ("df".to_owned(), colours.foreground),
                    ("dim".to_owned(), colours.foreground),
                ];
                themed.extend((0..16).map(|ix| {
                    let code = if ix < 8 { 30 + ix } else { 82 + ix };
                    (format!("c{code}"), colours.ansi[ix])
                }));
                for (text, given) in themed {
                    let painted = span(&layout, &text).color;
                    assert!(reads(painted) >= minimum, "{palette:?} {mode:?} {text}");
                    if text != "dim" && reads(given) >= minimum {
                        assert_eq!(painted, given, "{palette:?} {mode:?} {text}: reads already");
                    }
                }
                assert_eq!(span(&layout, "i236").color, colours.indexed(236), "{palette:?}");
                assert_eq!(span(&layout, "●").color, colours.ansi[0], "{palette:?} {mode:?}");
                let cursor = layout.cursor.as_ref().and_then(|cursor| cursor.text.as_ref());
                assert_eq!(cursor.map(|text| text.color), Some(background), "the cursor's cell");
            }
        }
    }

    #[test]
    fn the_link_under_the_pointer_is_underlined() {
        let content = picture("go https://a.io now");
        let palette = palette();
        let maka = MakaPalette::light();
        let style = GridStyle {
            palette: &palette,
            find_match: maka.find_match,
            find_match_active: maka.find_match_active,
            focused: true,
            cursor: true,
            minimum_contrast: 0.,
            link: Some((Point::new(Line(0), Column(3)), Point::new(Line(1), Column(2)))),
        };
        let layout = layout(&content, &style, &[], None);
        let underlined: Vec<&str> = layout
            .spans
            .iter()
            .filter(|span| span.underline.is_some())
            .map(|span| span.text.as_str())
            .collect();
        // 12 columns: the address wraps after "https://a".
        assert_eq!(underlined, ["https://a", ".io"]);
        assert!(lay_out(&content, true).spans.iter().all(|span| span.underline.is_none()));
    }

    #[test]
    fn the_selection_and_matches_are_highlights_under_the_text() {
        let mut emulator = Emulator::new(PtySize::new(12, 4).expect("size"));
        emulator.advance("one two\r\nthree");
        emulator.start_selection(
            alacritty_terminal::selection::SelectionType::Simple,
            Point::new(Line(0), Column(4)),
            alacritty_terminal::index::Side::Left,
        );
        emulator.update_selection(
            Point::new(Line(1), Column(1)),
            alacritty_terminal::index::Side::Right,
        );
        let content = emulator.content();
        let palette = palette();
        let maka = MakaPalette::light();
        let style = GridStyle {
            palette: &palette,
            find_match: maka.find_match,
            find_match_active: maka.find_match_active,
            focused: true,
            cursor: true,
            minimum_contrast: 0.,
            link: None,
        };
        let found = [TerminalMatch {
            start: Point::new(Line(1), Column(0)),
            end: Point::new(Line(1), Column(4)),
        }];
        let layout = layout(&content, &style, &found, Some(0));
        let rects: Vec<(usize, usize, usize, Hsla)> = layout
            .highlights
            .iter()
            .map(|rect| (rect.row, rect.column, rect.columns, rect.color))
            .collect();
        assert_eq!(
            rects,
            [
                (1, 0, 5, maka.find_match_active),
                (0, 4, 8, palette.selection),
                (1, 0, 2, palette.selection),
            ]
        );
    }
}
