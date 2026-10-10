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

//! The element that paints a terminal's picture: it sizes the cells from
//! the mono face, asks the terminal for the grid its bounds hold, lays the
//! picture out ([`super::grid`]) and paints it, and takes the window's
//! text input (the IME) while the terminal has focus.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::{Arc, LazyLock};

use alacritty_terminal::index::Point as GridPoint;
use gpui_kit::component::ActiveTheme as _;
use gpui_kit::{
    App, BorderStyle, Bounds, ContentMask, CursorStyle, Element, ElementId, ElementInputHandler,
    Entity, FocusHandle, Font, FontFeatures, FontStyle, FontWeight, GlobalElementId, Hitbox,
    HitboxBehavior, Hsla, InspectorElementId, IntoElement, LayoutId, PaintQuad, Pixels, Point,
    ShapedLine, SharedString, StrikethroughStyle, Style, TextAlign, TextRun, UnderlineStyle,
    Window, fill, outline, point, px, relative, size,
};
use shared::contrast;
use shared::theme::{ActiveMakaPalette as _, CODE_LINE_REMS, CODE_TEXT_REMS};

use super::TerminalView;
use super::box_drawing::{self, BoxGlyph};
use super::grid::{self, CursorKind, GridLayout, GridStyle, TextSpan, Underline};
use super::scrollbar::TerminalScroll;
use crate::{Terminal, TerminalContent, TerminalMatch};

/// Where the grid sits in the window and how big its cells are: what the
/// view maps the pointer to cells with, and the IME's position.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct GridGeometry {
    pub origin: Point<Pixels>,
    pub cell: gpui_kit::Size<Pixels>,
    /// The cells the picture has (not the bounds: a grid the Host clamps
    /// is letterboxed).
    pub columns: usize,
    pub rows: usize,
    pub display_offset: usize,
    /// The cursor's cell, where the IME composes.
    pub cursor: Option<Bounds<Pixels>>,
}

impl GridGeometry {
    /// The cell under `position`, clamped into the grid, and which half of
    /// it the pointer is in (`true`: the right).
    pub fn cell_at(&self, position: Point<Pixels>) -> (usize, usize, bool) {
        let x = f32::from(position.x - self.origin.x).max(0.);
        let y = f32::from(position.y - self.origin.y).max(0.);
        let width = f32::from(self.cell.width).max(1.);
        let height = f32::from(self.cell.height).max(1.);
        let column = ((x / width) as usize).min(self.columns.saturating_sub(1));
        let row = ((y / height) as usize).min(self.rows.saturating_sub(1));
        let right = x - column as f32 * width > width / 2.;
        (column, row, right)
    }
}

/// The mono face with ligatures off: a terminal's cells are characters,
/// and `->` must stay two of them.
fn mono_font(cx: &App) -> Font {
    static NO_LIGATURES: LazyLock<FontFeatures> = LazyLock::new(|| {
        FontFeatures(Arc::new(vec![("calt".into(), 0), ("liga".into(), 0), ("dlig".into(), 0)]))
    });
    let mut font = gpui_kit::font(cx.theme().mono_font_family.clone());
    font.features = NO_LIGATURES.clone();
    font
}

/// The cell size and font size at the window's rem: the code rung, so the
/// application zoom (⌘+, ⌘−, ⌘0) resizes the cells and with them the grid.
pub(crate) fn cell_metrics(window: &Window, cx: &App) -> (gpui_kit::Size<Pixels>, Pixels) {
    let rem = window.rem_size();
    let font_size = rem * CODE_TEXT_REMS;
    let line_height = rem * CODE_LINE_REMS;
    let font_id = window.text_system().resolve_font(&mono_font(cx));
    let width = window
        .text_system()
        .advance(font_id, font_size, 'm')
        .map(|advance| advance.width)
        .unwrap_or(font_size * 0.6);
    (size(width.max(px(1.)), line_height), font_size)
}

/// The bounds of `rows` × `columns` cells from (`row`, `column`), snapped
/// outwards to device pixels (`scale` of them per point): the start floors,
/// the end ceils, so neighbours touch or overlap by at most one device
/// pixel and no seam shows between cells or rows at any cell size.
pub(crate) fn snapped_cells(
    origin: Point<Pixels>,
    cell: gpui_kit::Size<Pixels>,
    scale: f32,
    (row, column): (usize, usize),
    (rows, columns): (usize, usize),
) -> Bounds<Pixels> {
    let floor = |value: Pixels| px((f32::from(value) * scale).floor() / scale);
    let ceil = |value: Pixels| px((f32::from(value) * scale).ceil() / scale);
    let left = floor(origin.x + cell.width * column as f32);
    let top = floor(origin.y + cell.height * row as f32);
    let right = ceil(origin.x + cell.width * (column + columns) as f32);
    let bottom = ceil(origin.y + cell.height * (row + rows) as f32);
    Bounds::new(point(left, top), size(right - left, bottom - top))
}

/// Paints the active terminal's picture.
pub(crate) struct TerminalElement {
    view: Entity<TerminalView>,
    terminal: Entity<Terminal>,
    focus: FocusHandle,
    content: Arc<TerminalContent>,
    focused: bool,
    cursor: bool,
    matches: Rc<[TerminalMatch]>,
    active_match: Option<usize>,
    /// The IME's composition, drawn at the cursor.
    marked: Option<SharedString>,
    geometry: Rc<Cell<Option<GridGeometry>>>,
    /// The link under the pointer while ⌘ is held: underlined, with the
    /// pointing hand over the grid.
    link: Option<(GridPoint, GridPoint)>,
    /// The cursor is in the hidden phase of its blink: laid out (the IME
    /// still opens there) but not painted.
    cursor_blinked_off: bool,
    scroll: Option<TerminalScroll>,
}

impl TerminalElement {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        view: Entity<TerminalView>,
        terminal: Entity<Terminal>,
        focus: FocusHandle,
        content: Arc<TerminalContent>,
        focused: bool,
        cursor: bool,
        matches: Rc<[TerminalMatch]>,
        active_match: Option<usize>,
        marked: Option<SharedString>,
        geometry: Rc<Cell<Option<GridGeometry>>>,
    ) -> Self {
        Self {
            view,
            terminal,
            focus,
            content,
            focused,
            cursor,
            matches,
            active_match,
            marked,
            geometry,
            link: None,
            cursor_blinked_off: false,
            scroll: None,
        }
    }

    pub(crate) fn link(mut self, link: Option<(GridPoint, GridPoint)>) -> Self {
        self.link = link;
        self
    }

    pub(crate) fn cursor_blinked_off(mut self, off: bool) -> Self {
        self.cursor_blinked_off = off;
        self
    }

    /// The scrollbar's handle, told what each picture shows.
    pub(crate) fn scroll(mut self, scroll: TerminalScroll) -> Self {
        self.scroll = Some(scroll);
        self
    }
}

/// What prepaint worked out for paint.
pub(crate) struct Prepainted {
    layout: GridLayout,
    origin: Point<Pixels>,
    cell: gpui_kit::Size<Pixels>,
    spans: Vec<(Point<Pixels>, ShapedLine)>,
    cursor_text: Option<(Point<Pixels>, ShapedLine)>,
    marked: Option<(Bounds<Pixels>, ShapedLine)>,
    background: Hsla,
    hitbox: Hitbox,
}

impl IntoElement for TerminalElement {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

/// Shapes `span` at the cell width: every character lands on its column.
fn shape(
    span: &TextSpan,
    font: &Font,
    font_size: Pixels,
    cell_width: Pixels,
    window: &Window,
) -> ShapedLine {
    let mut font = font.clone();
    if span.bold {
        font.weight = FontWeight::BOLD;
    }
    if span.italic {
        font.style = FontStyle::Italic;
    }
    let thickness = px(1.);
    let run = TextRun {
        len: span.text.len(),
        font,
        color: span.color,
        background_color: None,
        underline: span.underline.map(|kind| UnderlineStyle {
            thickness,
            color: Some(span.color),
            wavy: kind == Underline::Curly,
        }),
        strikethrough: span
            .strikethrough
            .then_some(StrikethroughStyle { thickness, color: Some(span.color) }),
    };
    let force = (!span.wide).then_some(cell_width);
    window.text_system().shape_line(span.text.clone().into(), font_size, &[run], force)
}

impl Element for TerminalElement {
    type RequestLayoutState = ();
    type PrepaintState = Prepainted;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, None, cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Prepainted {
        let (cell, font_size) = cell_metrics(window, cx);
        // The grid the bounds hold, for the PTY: the terminal sends a
        // resize only when it changed, and clamps it to what the Host takes.
        let columns = (f32::from(bounds.size.width) / f32::from(cell.width)).floor().max(0.);
        let rows = (f32::from(bounds.size.height) / f32::from(cell.height)).floor().max(0.);
        let wanted =
            (columns.min(f32::from(u16::MAX)) as u16, rows.min(f32::from(u16::MAX)) as u16);
        let clamped = host_protocol::PtySize::clamped(wanted.0, wanted.1);
        if wanted.0 > 0 && wanted.1 > 0 && self.terminal.read(cx).grid() != Some(clamped) {
            let terminal = self.terminal.downgrade();
            cx.defer(move |cx| {
                terminal.update(cx, |terminal, cx| terminal.set_grid(wanted.0, wanted.1, cx)).ok();
            });
        }

        // Where the scrollbar was dragged to: the terminal scrolls there.
        if let Some(display_offset) =
            self.scroll.as_ref().and_then(|scroll| scroll.painted(&self.content, cell.height))
        {
            let terminal = self.terminal.downgrade();
            cx.defer(move |cx| {
                terminal.update(cx, |terminal, _| terminal.scroll_to_offset(display_offset)).ok();
            });
        }

        let palette = cx.terminal_palette();
        let maka = cx.maka();
        let style = GridStyle {
            palette: &palette,
            find_match: maka.find_match,
            find_match_active: maka.find_match_active,
            focused: self.focused,
            cursor: self.cursor,
            minimum_contrast: contrast::MINIMUM_CONTRAST,
            link: self.link,
        };
        let layout = grid::layout(&self.content, &style, &self.matches, self.active_match);
        let origin = bounds.origin;
        let font = mono_font(cx);
        let at = |row: usize, column: usize| {
            point(origin.x + cell.width * column as f32, origin.y + cell.height * row as f32)
        };
        let spans = layout
            .spans
            .iter()
            .map(|span| {
                (at(span.row, span.column), shape(span, &font, font_size, cell.width, window))
            })
            .collect();
        let cursor_bounds = layout.cursor.as_ref().map(|cursor| {
            Bounds::new(
                at(cursor.row, cursor.column),
                size(cell.width * cursor.columns as f32, cell.height),
            )
        });
        let cursor_text = layout.cursor.as_ref().and_then(|cursor| {
            let text = cursor.text.as_ref()?;
            Some((at(cursor.row, cursor.column), shape(text, &font, font_size, cell.width, window)))
        });
        let marked = self.marked.as_ref().filter(|text| !text.is_empty()).and_then(|text| {
            let cursor = cursor_bounds?;
            let span = TextSpan {
                row: 0,
                column: 0,
                columns: 0,
                text: text.to_string(),
                color: palette.foreground,
                bold: false,
                italic: false,
                underline: Some(Underline::Straight),
                strikethrough: false,
                wide: true,
            };
            let line = shape(&span, &font, font_size, cell.width, window);
            let width = line.width().max(cell.width);
            Some((Bounds::new(cursor.origin, size(width, cell.height)), line))
        });
        let picture_columns = usize::from(self.content.size.cols);
        let picture_rows = usize::from(self.content.size.rows);
        self.geometry.set(Some(GridGeometry {
            origin,
            cell,
            columns: picture_columns,
            rows: picture_rows,
            display_offset: self.content.display_offset,
            cursor: cursor_bounds,
        }));
        Prepainted {
            layout,
            origin,
            cell,
            spans,
            cursor_text,
            marked,
            background: palette.background,
            hitbox: window.insert_hitbox(bounds, HitboxBehavior::Normal),
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepainted: &mut Prepainted,
        window: &mut Window,
        cx: &mut App,
    ) {
        let scale = window.scale_factor();
        let (origin, cell) = (prepainted.origin, prepainted.cell);
        let line_height = cell.height;
        let cells = |row: usize, column: usize, rows: usize, columns: usize| {
            snapped_cells(origin, cell, scale, (row, column), (rows, columns))
        };
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for rect in &prepainted.layout.backgrounds {
                window.paint_quad(fill(
                    cells(rect.row, rect.column, rect.rows, rect.columns),
                    rect.color,
                ));
            }
            for rect in &prepainted.layout.highlights {
                window.paint_quad(fill(
                    cells(rect.row, rect.column, rect.rows, rect.columns),
                    rect.color,
                ));
            }
            for (at, line) in &prepainted.spans {
                line.paint(*at, line_height, TextAlign::Left, None, window, cx).ok();
            }
            let light = px((f32::from(cell.width) / 8.).round().max(1.));
            for glyph in &prepainted.layout.glyphs {
                let bounds = Bounds::new(
                    point(
                        origin.x + cell.width * glyph.column as f32,
                        origin.y + cell.height * glyph.row as f32,
                    ),
                    cell,
                );
                if let BoxGlyph::Arc(corner) = glyph.glyph {
                    let stroke = box_drawing::arc(corner, bounds, light, scale);
                    window.with_content_mask(Some(ContentMask { bounds: stroke.clip }), |window| {
                        window.paint_quad(PaintQuad {
                            bounds: stroke.bounds,
                            corner_radii: stroke.corner_radii,
                            background: gpui_kit::transparent_black().into(),
                            border_widths: stroke.border_widths,
                            border_color: glyph.color,
                            border_style: BorderStyle::Solid,
                        });
                    });
                    continue;
                }
                for (quad, alpha) in box_drawing::quads(&glyph.glyph, bounds, light, scale) {
                    window.paint_quad(fill(quad, glyph.color.opacity(alpha)));
                }
            }
            if let Some(cursor) =
                prepainted.layout.cursor.as_ref().filter(|_| !self.cursor_blinked_off)
            {
                let rect = cells(cursor.row, cursor.column, 1, cursor.columns);
                let stroke = px((f32::from(cell.width) / 7.).round().max(1.));
                match cursor.kind {
                    CursorKind::Block => {
                        window.paint_quad(fill(rect, cursor.color));
                        if let Some((at, line)) = &prepainted.cursor_text {
                            line.paint(*at, line_height, TextAlign::Left, None, window, cx).ok();
                        }
                    }
                    CursorKind::Underline => {
                        let bar = Bounds::new(
                            point(rect.origin.x, rect.bottom() - stroke),
                            size(rect.size.width, stroke),
                        );
                        window.paint_quad(fill(bar, cursor.color));
                    }
                    CursorKind::Bar => {
                        window.paint_quad(fill(
                            Bounds::new(rect.origin, size(stroke, rect.size.height)),
                            cursor.color,
                        ));
                    }
                    CursorKind::Hollow => {
                        window.paint_quad(outline(rect, cursor.color, BorderStyle::Solid));
                    }
                }
            }
            if let Some((rect, line)) = &prepainted.marked {
                window.paint_quad(fill(*rect, prepainted.background));
                line.paint(rect.origin, line_height, TextAlign::Left, None, window, cx).ok();
            }
        });
        if self.link.is_some() {
            window.set_cursor_style(CursorStyle::PointingHand, &prepainted.hitbox);
        }
        window.handle_input(&self.focus, ElementInputHandler::new(bounds, self.view.clone()), cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapped_cells_leave_no_seam_at_a_fractional_cell_size() {
        let origin = point(px(10.3), px(5.7));
        let cell = size(px(7.83), px(19.6));
        for scale in [1., 2., 3.] {
            for column in 0..40 {
                let one = snapped_cells(origin, cell, scale, (0, column), (1, 1));
                let next = snapped_cells(origin, cell, scale, (0, column + 1), (1, 1));
                assert!(one.right() >= next.left(), "a gap after column {column} at {scale}x");
                assert!(
                    one.right() - next.left() <= px(1. / scale + 1e-4),
                    "at most a device pixel"
                );
                let below = snapped_cells(origin, cell, scale, (1, column), (1, 1));
                assert!(one.bottom() >= below.top(), "a gap under row 0 at {scale}x");
            }
        }
        // A merged run covers exactly what its cells cover.
        let run = snapped_cells(origin, cell, 2., (3, 4), (2, 5));
        let first = snapped_cells(origin, cell, 2., (3, 4), (1, 1));
        let last = snapped_cells(origin, cell, 2., (4, 8), (1, 1));
        assert_eq!((run.left(), run.top()), (first.left(), first.top()));
        assert_eq!((run.right(), run.bottom()), (last.right(), last.bottom()));
    }
}
