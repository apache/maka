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
//! the text style it inherits (the script gives the theme's mono face and
//! size), reports the grid its bounds hold, lays the picture out
//! ([`super::grid`]) and paints it, and takes the window's text input (the
//! IME) while the terminal has focus. Ported from maka-gpui's terminal view.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::{Arc, LazyLock};

use gpui_shell::gpui::{
    App, BorderStyle, Bounds, ContentMask, DispatchPhase, Element, ElementId, ElementInputHandler,
    Entity, FocusHandle, Font, FontFeatures, FontStyle, FontWeight, GlobalElementId, Hsla,
    InspectorElementId, IntoElement, LayoutId, MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels,
    Point, ShapedLine, StrikethroughStyle, Style, TextAlign, TextRun, UnderlineStyle, Window, fill,
    outline, point, px, relative, size, transparent_black,
};

use super::box_drawing::{self, BoxGlyph};
use super::emulator::{GridSize, TerminalContent};
use super::grid::{self, CursorKind, GridLayout, GridStyle, TextSpan, Underline};
use super::palette::{MINIMUM_CONTRAST, TerminalPalette};
use super::view::TerminalView;

/// Where the grid sits in the window and how big its cells are: what the
/// view maps the pointer to cells with, and the IME's position.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct GridGeometry {
    pub origin: Point<Pixels>,
    pub cell: gpui_shell::gpui::Size<Pixels>,
    /// The cells the picture has (not the bounds: a PTY bigger than the
    /// bounds is cut off at their edge).
    pub columns: usize,
    pub rows: usize,
    pub display_offset: usize,
    /// The cursor's cell, where the IME composes and opens its candidates,
    /// whether or not the cursor shows.
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

/// The inherited font with ligatures off: a terminal's cells are
/// characters, and `->` must stay two of them.
fn mono_font(window: &Window) -> Font {
    static NO_LIGATURES: LazyLock<FontFeatures> = LazyLock::new(|| {
        FontFeatures(Arc::new(vec![
            ("calt".into(), 0),
            ("liga".into(), 0),
            ("dlig".into(), 0),
        ]))
    });
    let mut font = window.text_style().font();
    font.features = NO_LIGATURES.clone();
    font
}

/// The cell size and font size of the inherited text style: the width of
/// `m` at the font size, and the line height.
pub(crate) fn cell_metrics(window: &Window) -> (gpui_shell::gpui::Size<Pixels>, Pixels) {
    let style = window.text_style();
    let rem = window.rem_size();
    let font_size = style.font_size.to_pixels(rem);
    let line_height = style.line_height_in_pixels(rem);
    let font_id = window.text_system().resolve_font(&mono_font(window));
    let width = window
        .text_system()
        .advance(font_id, font_size, 'm')
        .map(|advance| advance.width)
        .unwrap_or(font_size * 0.6);
    (size(width.max(px(1.)), line_height.max(px(1.))), font_size)
}

/// The bounds of `rows` × `columns` cells from (`row`, `column`), snapped
/// outwards to device pixels (`scale` of them per point): the start floors,
/// the end ceils, so neighbours touch or overlap by at most one device
/// pixel and no seam shows between cells or rows at any cell size.
pub(crate) fn snapped_cells(
    origin: Point<Pixels>,
    cell: gpui_shell::gpui::Size<Pixels>,
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

/// The grid `bounds` hold at `cell`, within the sizes the Host's PTYs take
/// (2–240 columns, 1–100 rows); `None` while they hold no whole cell.
pub(crate) fn fitting_grid(
    bounds: gpui_shell::gpui::Size<Pixels>,
    cell: gpui_shell::gpui::Size<Pixels>,
) -> Option<GridSize> {
    let columns = (f32::from(bounds.width) / f32::from(cell.width)).floor();
    let rows = (f32::from(bounds.height) / f32::from(cell.height)).floor();
    (columns >= 1. && rows >= 1.)
        .then(|| GridSize::new(columns.clamp(2., 240.) as u16, rows.clamp(1., 100.) as u16))
}

/// Where the grid's top left corner goes in `bounds`: at their top left,
/// unless the PTY has more rows than they hold (another client sized it),
/// when the top rows are cut off instead of the bottom ones, where the
/// program writes.
pub(crate) fn grid_origin(
    bounds: Bounds<Pixels>,
    cell: gpui_shell::gpui::Size<Pixels>,
    rows: usize,
) -> Point<Pixels> {
    let held = (f32::from(bounds.size.height) / f32::from(cell.height).max(1.)).floor() as usize;
    let hidden = rows.saturating_sub(held.max(1));
    point(
        bounds.origin.x,
        bounds.origin.y - cell.height * hidden as f32,
    )
}

/// Paints one terminal's picture.
pub(crate) struct TerminalElement {
    pub view: Entity<TerminalView>,
    pub focus: FocusHandle,
    pub content: Arc<TerminalContent>,
    pub palette: TerminalPalette,
    pub focused: bool,
    /// Whether to draw the cursor at all (not over an ended terminal).
    pub cursor: bool,
    /// The cursor is in the hidden phase of its blink: laid out (the IME
    /// still opens there) but not painted.
    pub cursor_blinked_off: bool,
    /// The IME's composition, drawn at the cursor.
    pub marked: Option<String>,
    pub geometry: Rc<Cell<Option<GridGeometry>>>,
}

/// What prepaint worked out for paint.
pub(crate) struct Prepainted {
    layout: GridLayout,
    origin: Point<Pixels>,
    cell: gpui_shell::gpui::Size<Pixels>,
    spans: Vec<(Point<Pixels>, ShapedLine)>,
    cursor_text: Option<(Point<Pixels>, ShapedLine)>,
    marked: Option<(Bounds<Pixels>, ShapedLine)>,
    background: Hsla,
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
        strikethrough: span.strikethrough.then_some(StrikethroughStyle {
            thickness,
            color: Some(span.color),
        }),
    };
    let force = (!span.wide).then_some(cell_width);
    window
        .text_system()
        .shape_line(span.text.clone().into(), font_size, &[run], force)
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
        let (cell, font_size) = cell_metrics(window);
        // The grid the bounds hold, for the script to size the PTY to; the
        // view reports it only when it changed.
        if let Some(grid) = fitting_grid(bounds.size, cell)
            && self.view.read(cx).reported_grid() != Some(grid)
        {
            let view = self.view.downgrade();
            cx.defer(move |cx| {
                view.update(cx, |view, cx| view.fits(grid, cx)).ok();
            });
        }
        let style = GridStyle {
            palette: &self.palette,
            focused: self.focused,
            cursor: self.cursor,
            minimum_contrast: MINIMUM_CONTRAST,
        };
        let layout = grid::layout(&self.content, &style);
        let origin = grid_origin(bounds, cell, usize::from(self.content.size.rows));
        let font = mono_font(window);
        let at = |row: usize, column: usize| {
            point(
                origin.x + cell.width * column as f32,
                origin.y + cell.height * row as f32,
            )
        };
        let spans = layout
            .spans
            .iter()
            .map(|span| {
                (
                    at(span.row, span.column),
                    shape(span, &font, font_size, cell.width, window),
                )
            })
            .collect();
        // The IME works at the cursor's cell even while the program hides
        // the cursor, as editors do while they draw their own.
        let caret_bounds = layout.caret.map(|caret| {
            Bounds::new(
                at(caret.row, caret.column),
                size(cell.width * caret.columns as f32, cell.height),
            )
        });
        let cursor_text = layout.cursor.as_ref().and_then(|cursor| {
            let text = cursor.text.as_ref()?;
            Some((
                at(cursor.row, cursor.column),
                shape(text, &font, font_size, cell.width, window),
            ))
        });
        let marked = self
            .marked
            .as_ref()
            .filter(|text| !text.is_empty())
            .and_then(|text| {
                let cursor = caret_bounds?;
                let span = TextSpan {
                    row: 0,
                    column: 0,
                    columns: 0,
                    text: text.clone(),
                    color: self.palette.foreground,
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
        self.geometry.set(Some(GridGeometry {
            origin,
            cell,
            columns: usize::from(self.content.size.cols),
            rows: usize::from(self.content.size.rows),
            display_offset: self.content.display_offset,
            cursor: caret_bounds,
        }));
        Prepainted {
            layout,
            origin,
            cell,
            spans,
            cursor_text,
            marked,
            background: self.palette.background,
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
                line.paint(*at, line_height, TextAlign::Left, None, window, cx)
                    .ok();
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
                    window.with_content_mask(
                        Some(ContentMask {
                            bounds: stroke.clip,
                        }),
                        |window| {
                            window.paint_quad(PaintQuad {
                                bounds: stroke.bounds,
                                corner_radii: stroke.corner_radii,
                                background: transparent_black().into(),
                                border_widths: stroke.border_widths,
                                border_color: glyph.color,
                                border_style: BorderStyle::Solid,
                            });
                        },
                    );
                    continue;
                }
                for (quad, alpha) in box_drawing::quads(&glyph.glyph, bounds, light, scale) {
                    window.paint_quad(fill(quad, glyph.color.opacity(alpha)));
                }
            }
            if let Some(cursor) = prepainted
                .layout
                .cursor
                .as_ref()
                .filter(|_| !self.cursor_blinked_off)
            {
                let rect = cells(cursor.row, cursor.column, 1, cursor.columns);
                let stroke = px((f32::from(cell.width) / 7.).round().max(1.));
                match cursor.kind {
                    CursorKind::Block => {
                        window.paint_quad(fill(rect, cursor.color));
                        if let Some((at, line)) = &prepainted.cursor_text {
                            line.paint(*at, line_height, TextAlign::Left, None, window, cx)
                                .ok();
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
                line.paint(rect.origin, line_height, TextAlign::Left, None, window, cx)
                    .ok();
            }
        });
        window.handle_input(
            &self.focus,
            ElementInputHandler::new(bounds, self.view.clone()),
            cx,
        );
        // A press that started here follows the pointer anywhere in the
        // window until it is released, also outside the terminal: the
        // selection keeps extending, and the program gets its drag and its
        // release. In the capture phase, so nothing above takes them first.
        let view = self.view.clone();
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
            if phase == DispatchPhase::Capture {
                view.update(cx, |view, cx| view.drag(event, cx));
            }
        });
        let view = self.view.clone();
        window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
            if phase == DispatchPhase::Capture {
                view.update(cx, |view, cx| view.release(event, cx));
            }
        });
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
                assert!(
                    one.right() >= next.left(),
                    "a gap after column {column} at {scale}x"
                );
                assert!(one.right() - next.left() <= px(1. / scale + 1e-4));
                let below = snapped_cells(origin, cell, scale, (1, column), (1, 1));
                assert!(one.bottom() >= below.top(), "a gap under row 0 at {scale}x");
            }
        }
    }

    #[test]
    fn the_grid_the_bounds_hold_stays_within_what_the_host_takes() {
        let cell = size(px(8.4), px(20.));
        let grid = |width: f32, height: f32| fitting_grid(size(px(width), px(height)), cell);
        assert_eq!(grid(400., 300.), Some(GridSize::new(47, 15)));
        assert_eq!(grid(5000., 5000.), Some(GridSize::new(240, 100)));
        assert_eq!(
            grid(9., 20.),
            Some(GridSize::new(2, 1)),
            "at least two columns"
        );
        assert_eq!(grid(5., 300.), None, "no whole cell");
        assert_eq!(grid(400., 10.), None);
    }

    #[test]
    fn a_pty_taller_than_the_bounds_keeps_its_bottom_rows() {
        let cell = size(px(8.), px(20.));
        let bounds = Bounds::new(point(px(10.), px(100.)), size(px(400.), px(200.)));
        assert_eq!(grid_origin(bounds, cell, 10), point(px(10.), px(100.)));
        assert_eq!(grid_origin(bounds, cell, 4), point(px(10.), px(100.)));
        // 12 rows in room for 10: the first two are above the bounds.
        assert_eq!(grid_origin(bounds, cell, 12), point(px(10.), px(60.)));
    }
}
