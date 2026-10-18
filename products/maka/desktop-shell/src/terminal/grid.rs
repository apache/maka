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
//! no window: the backgrounds, the selection, the text runs, the cells drawn
//! as quads, and the cursor, all in cells. The element turns them into
//! pixels ([`super::element`]). Ported from maka-gpui's terminal view.
//!
//! Zed's terminal (GPL-3.0) informed the practice, not the code: adjacent
//! cells of one style make one run, shaped at a forced cell width so every
//! glyph lands on its column; a wide character is a run of its own, two
//! cells wide; zero-width characters ride on their cell; backgrounds are
//! separate rectangles merged along a row and down identical rows;
//! box-drawing and block characters are quads; themed text is raised to a
//! minimum contrast against its fill ([`super::palette`]).

use std::collections::HashMap;

use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor, Rgb};
use gpui_shell::gpui::{Hsla, Rgba};

use super::box_drawing::{self, BoxGlyph};
use super::emulator::TerminalContent;
use super::palette::{self, TerminalPalette};

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

/// The cursor's cell, drawn or not: where the IME composes and opens its
/// candidates, even while the program hides the cursor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Caret {
    pub row: usize,
    pub column: usize,
    /// Two over a wide character.
    pub columns: usize,
}

/// Everything one picture paints, in painting order: backgrounds, then the
/// selection, then text and quads, then the cursor.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct GridLayout {
    pub backgrounds: Vec<CellRect>,
    pub highlights: Vec<CellRect>,
    pub spans: Vec<TextSpan>,
    pub glyphs: Vec<GlyphCell>,
    pub cursor: Option<CursorSpec>,
    /// `None` only while the cursor's row is scrolled out of view.
    pub caret: Option<Caret>,
}

/// What a picture is painted with besides its cells.
pub(crate) struct GridStyle<'a> {
    pub palette: &'a TerminalPalette,
    pub focused: bool,
    /// Whether to draw the cursor at all (not over an ended terminal).
    pub cursor: bool,
    /// The least APCA lightness contrast themed text is raised to
    /// ([`palette::MINIMUM_CONTRAST`]; 0 leaves every colour as it is).
    pub minimum_contrast: f32,
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
    Rgba {
        r: channel(color.r),
        g: channel(color.g),
        b: channel(color.b),
        a: 1.,
    }
    .into()
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

/// A colour as a hash key: its bits.
fn colour_key(color: Hsla) -> [u32; 4] {
    [
        color.h.to_bits(),
        color.s.to_bits(),
        color.l.to_bits(),
        color.a.to_bits(),
    ]
}

/// Themed ink raised to the minimum contrast, each pair of ink and fill
/// worked out once per picture. A program that paints many 24-bit fills
/// makes as many pairs as cells, so they are hashed, not searched.
struct Contrast {
    minimum: f32,
    raised: HashMap<([u32; 4], [u32; 4]), Hsla>,
}

impl Contrast {
    fn ink(&mut self, fg: Hsla, bg: Hsla) -> Hsla {
        if self.minimum <= 0. {
            return fg;
        }
        *self
            .raised
            .entry((colour_key(fg), colour_key(bg)))
            .or_insert_with(|| palette::ensure_contrast(fg, bg, self.minimum))
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
    let c = if cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) {
        ' '
    } else {
        cell.c
    };
    let mut text = String::from(c);
    if let Some(zero_width) = cell.zerowidth() {
        text.extend(zero_width.iter());
    }
    text
}

/// Lays out `content` in cells.
pub(crate) fn layout(content: &TerminalContent, style: &GridStyle) -> GridLayout {
    let colours = Colours {
        palette: style.palette,
        overrides: &content.colors,
    };
    let default_background = colours.named(NamedColor::Background);
    let columns = usize::from(content.size.cols).max(1);
    let rows = content.cells.len() / columns;
    let mut out = GridLayout::default();
    let mut contrast = Contrast {
        minimum: style.minimum_contrast,
        raised: HashMap::new(),
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
            let width = if cell.flags.contains(Flags::WIDE_CHAR) {
                2
            } else {
                1
            };
            if bg != default_background {
                match row_rects.last_mut() {
                    Some(last) if last.color == bg && last.column + last.columns == column => {
                        last.columns += width;
                    }
                    _ => row_rects.push(CellRect {
                        row,
                        column,
                        columns: width,
                        rows: 1,
                        color: bg,
                    }),
                }
            }
            let hidden = cell.flags.contains(Flags::HIDDEN);
            if let Some(glyph) = (!hidden).then(|| box_drawing::glyph(cell.c)).flatten() {
                out.spans.extend(run.take().map(OpenRun::close));
                out.glyphs.push(GlyphCell {
                    row,
                    column,
                    glyph,
                    color: fg,
                });
                continue;
            }
            // Contrast is measured against what the cell shows: its own fill,
            // or the terminal's where it has none.
            let fill = if bg.a < 1. {
                default_background.blend(bg)
            } else {
                bg
            };
            let ink = if themed && !is_decorative(cell.c) {
                contrast.ink(fg, fill)
            } else {
                fg
            };
            let run_style = RunStyle::of(cell, ink, bg);
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
    out.highlights = selection(content, columns, rows, style);
    out.caret = caret(content, columns, rows);
    out.cursor = out
        .caret
        .and_then(|caret| cursor(content, caret, columns, &colours, style));
    out
}

/// The selection's cells, merged along each row.
fn selection(
    content: &TerminalContent,
    columns: usize,
    rows: usize,
    style: &GridStyle,
) -> Vec<CellRect> {
    let Some(selection) = &content.selection else {
        return Vec::new();
    };
    let offset = i32::try_from(content.display_offset).unwrap_or(i32::MAX);
    let mut out = Vec::new();
    for row in 0..rows {
        let line = Line(i32::try_from(row).unwrap_or(i32::MAX) - offset);
        let mut start: Option<usize> = None;
        for column in 0..=columns {
            let selected = column < columns && selection.contains(Point::new(line, Column(column)));
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
    out
}

/// The cursor's cell on the screen as it is scrolled, whether or not the
/// cursor shows.
fn caret(content: &TerminalContent, columns: usize, rows: usize) -> Option<Caret> {
    let row = usize::try_from(
        i64::from(content.cursor.point.line.0)
            + i64::try_from(content.display_offset).unwrap_or(i64::MAX),
    )
    .ok()
    .filter(|row| *row < rows)?;
    let column = content.cursor.point.column.0.min(columns - 1);
    let cell = &content.cells.get(row * columns + column)?.cell;
    let columns = if cell.flags.contains(Flags::WIDE_CHAR) {
        2
    } else {
        1
    };
    Some(Caret {
        row,
        column,
        columns,
    })
}

/// The cursor as it is drawn: not at all when the program hid it.
fn cursor(
    content: &TerminalContent,
    Caret {
        row,
        column,
        columns: width,
    }: Caret,
    columns: usize,
    colours: &Colours,
    style: &GridStyle,
) -> Option<CursorSpec> {
    if !style.cursor || content.cursor.shape == CursorShape::Hidden {
        return None;
    }
    let cell = &content.cells.get(row * columns + column)?.cell;
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
            RunStyle {
                color: bg,
                ..RunStyle::of(cell, fg, bg)
            }
            .span(row, column, cell_text(cell), width, width == 2)
        });
    Some(CursorSpec {
        row,
        column,
        columns: width,
        kind,
        color,
        text,
    })
}

#[cfg(test)]
mod tests {
    use alacritty_terminal::index::{Column, Line, Point, Side};
    use alacritty_terminal::selection::SelectionType;

    use super::*;
    use crate::terminal::emulator::{Emulator, GridSize};

    fn picture(text: &str) -> TerminalContent {
        let mut emulator = Emulator::new(GridSize::new(12, 4));
        emulator.advance(text.as_bytes());
        emulator.content()
    }

    fn lay_out(content: &TerminalContent, focused: bool) -> GridLayout {
        let palette = TerminalPalette::default();
        let style = GridStyle {
            palette: &palette,
            focused,
            cursor: true,
            minimum_contrast: 0.,
        };
        layout(content, &style)
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
        let layout = lay_out(
            &picture("\x1b[31mred\x1b[0m plain\r\n\x1b[1mbold\x1b[0m\r\nab cd"),
            true,
        );
        assert_eq!(
            texts(&layout),
            [
                (0, 0, 3, "red"),
                (0, 4, 5, "plain"),
                (1, 0, 4, "bold"),
                (2, 0, 5, "ab cd")
            ],
            "a style change starts a run, a blank inside one stays, a leading one is skipped"
        );
        let palette = TerminalPalette::default();
        assert_eq!(layout.spans[0].color, palette.ansi[1]);
        assert_eq!(layout.spans[1].color, palette.foreground);
        assert!(layout.spans[2].bold);
    }

    #[test]
    fn a_wide_character_is_its_own_run_over_two_cells() {
        let layout = lay_out(&picture("a中b"), true);
        assert_eq!(
            texts(&layout),
            [(0, 0, 1, "a"), (0, 1, 2, "中"), (0, 3, 1, "b")]
        );
        assert!(layout.spans[1].wide);
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
    fn backgrounds_merge_along_rows_and_down_identical_ones() {
        let layout = lay_out(
            &picture("\x1b[44mab\x1b[0m\r\n\x1b[44mcd\x1b[0m\r\n\x1b[41me\x1b[42mf"),
            true,
        );
        let blue = TerminalPalette::default().ansi[4];
        assert_eq!(
            layout.backgrounds[0],
            CellRect {
                row: 0,
                column: 0,
                columns: 2,
                rows: 2,
                color: blue
            }
        );
        let (red, green) = (&layout.backgrounds[1], &layout.backgrounds[2]);
        assert_eq!((red.row, red.column, red.columns), (2, 0, 1));
        assert_eq!(red.column + red.columns, green.column);
        assert_eq!(layout.backgrounds.len(), 3);
    }

    #[test]
    fn the_cursor_takes_the_programs_shape_and_is_hollow_without_focus() {
        let kind = |text: &str, focused: bool| {
            lay_out(&picture(text), focused)
                .cursor
                .map(|cursor| cursor.kind)
        };
        assert_eq!(kind("ab", true), Some(CursorKind::Block));
        assert_eq!(kind("ab\x1b[4 q", true), Some(CursorKind::Underline));
        assert_eq!(kind("ab\x1b[6 q", true), Some(CursorKind::Bar));
        assert_eq!(kind("ab", false), Some(CursorKind::Hollow));
        assert_eq!(kind("ab\x1b[?25l", true), None);
        let cursor = lay_out(&picture("ab\x1b[D"), true).cursor.expect("cursor");
        assert_eq!((cursor.row, cursor.column), (0, 1));
        let text = cursor.text.expect("the character under it");
        assert_eq!(
            (text.text.as_str(), text.color),
            ("b", TerminalPalette::default().background)
        );
    }

    #[test]
    fn a_faint_ink_is_raised_and_a_programs_24_bit_colour_is_left_alone() {
        let mut palette = TerminalPalette::default();
        palette.background = palette::parse_color("#111113").unwrap();
        palette.foreground = palette::parse_color("#3a3a40").unwrap();
        let content = picture("dim \x1b[38;2;40;40;50mrgb\x1b[0m");
        let style = GridStyle {
            palette: &palette,
            focused: true,
            cursor: false,
            minimum_contrast: palette::MINIMUM_CONTRAST,
        };
        let layout = layout(&content, &style);
        let raised = layout.spans[0].color;
        assert_ne!(raised, palette.foreground);
        assert!(
            palette::lightness_contrast(raised, palette.background).abs()
                >= palette::MINIMUM_CONTRAST
        );
        assert_eq!(layout.spans[1].color, palette::opaque(40, 40, 50));
    }

    #[test]
    fn a_hidden_cursor_still_has_its_cell_for_the_ime() {
        let shown = lay_out(&picture("ab"), true);
        assert_eq!(
            shown.caret,
            Some(Caret {
                row: 0,
                column: 2,
                columns: 1
            })
        );
        assert!(shown.cursor.is_some());
        let hidden = lay_out(&picture("ab\x1b[?25l"), true);
        assert_eq!(hidden.cursor, None, "the program hid it");
        assert_eq!(hidden.caret, shown.caret);
    }

    #[test]
    fn decorative_characters_keep_their_ink() {
        let mut palette = TerminalPalette::default();
        palette.background = palette::parse_color("#111113").unwrap();
        palette.foreground = palette::parse_color("#3a3a40").unwrap();
        // A letter, then a geometric shape and a Braille pattern (text, not
        // box-drawing quads), all in the faint default ink.
        let content = picture("a \u{25A0} \u{283F}");
        let style = GridStyle {
            palette: &palette,
            focused: true,
            cursor: false,
            minimum_contrast: palette::MINIMUM_CONTRAST,
        };
        let layout = layout(&content, &style);
        let colour = |text: &str| {
            layout
                .spans
                .iter()
                .find(|span| span.text.contains(text))
                .map(|span| span.color)
                .unwrap()
        };
        assert_ne!(colour("a"), palette.foreground, "a letter is raised");
        assert_eq!(colour("\u{25A0}"), palette.foreground);
        assert_eq!(colour("\u{283F}"), palette.foreground);
    }

    /// A measurement, not a check: `cargo test -p maka-desktop-shell
    /// many_24_bit -- --ignored --nocapture`. Searching the pairs took 1.3 s
    /// in a debug build and 150 ms in a release one; hashed, 80 ms and 18.
    #[test]
    #[ignore = "a measurement; run it with --ignored --nocapture"]
    fn many_24_bit_fills_lay_out_quickly() {
        // 240 x 100 cells, each on a fill of its own, in the default ink:
        // a pair to raise per cell.
        let mut emulator = Emulator::new(GridSize::new(240, 100));
        let mut text = String::new();
        for row in 0..100u32 {
            for column in 0..240u32 {
                text.push_str(&format!("\x1b[48;2;{};{};{}mx", row, column % 256, 7));
            }
            if row < 99 {
                text.push_str("\r\n");
            }
        }
        emulator.advance(text.as_bytes());
        let content = emulator.content();
        let palette = TerminalPalette::default();
        let style = GridStyle {
            palette: &palette,
            focused: true,
            cursor: true,
            minimum_contrast: palette::MINIMUM_CONTRAST,
        };
        let started = std::time::Instant::now();
        let layout = layout(&content, &style);
        let took = started.elapsed();
        assert_eq!(layout.spans.len(), 24_000);
        eprintln!("24,000 cells on 24,000 fills laid out in {took:?}");
    }

    #[test]
    fn the_selection_is_a_highlight_under_the_text() {
        let mut emulator = Emulator::new(GridSize::new(12, 4));
        emulator.advance(b"one two\r\nthree");
        emulator.start_selection(
            SelectionType::Simple,
            Point::new(Line(0), Column(4)),
            Side::Left,
        );
        emulator.update_selection(Point::new(Line(1), Column(1)), Side::Right);
        let palette = TerminalPalette::default();
        let layout = lay_out(&emulator.content(), true);
        let rects: Vec<(usize, usize, usize, Hsla)> = layout
            .highlights
            .iter()
            .map(|rect| (rect.row, rect.column, rect.columns, rect.color))
            .collect();
        assert_eq!(
            rects,
            [(0, 4, 8, palette.selection), (1, 0, 2, palette.selection)]
        );
    }
}
