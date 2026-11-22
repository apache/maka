//! Canvas views drawn in braille dots: the drawing's operations replayed
//! against a small 2D context (transform, save / restore, paints, global
//! alpha, dashes, clips) onto a grid of 2 × 4 dots per Cell, which
//! ratatui's `Canvas` turns into braille symbols. Fills set the dots whose
//! centers the fill rule puts inside the path (a translucent one, a wash
//! under the marks, only a sparse floor of them), strokes the dots along each
//! segment, and text is printed on whole Cells above the dots, with the
//! Cell before and after it cleared of dots so a label never runs into a
//! mark. A nearly transparent stroke or fill (hatching, a faint track) is
//! texture and left out.
//!
//! Only the part of the canvas inside its visible Cells is replayed onto,
//! so a canvas partly scrolled away keeps its dots where they were. A Cell
//! shows one color: that of the dot painted last in it. Line widths, caps,
//! joins, shadows, compositing and images are Decorative features left out.

mod path;

use std::{rc::Rc, sync::Arc};

use nsh_core::{
    animation::AnimationValue,
    canvas::{
        CanvasOp, CanvasTextAlign, CanvasTextBaseline, Drawing, FillRule, Num, Paint, PathOp,
    },
};
use ratatui_core::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    symbols::Marker,
    widgets::Widget,
};
use ratatui_widgets::canvas::{Canvas, Painter, Shape};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use self::path::{Dash, IDENTITY, Matrix, Outline, apply, distance, mean_scale, multiply};
use crate::{
    CellSize,
    geometry::{CellBounds, TextRun},
    palette::{self, Ground},
};

const DOTS_ACROSS: usize = 2;
const DOTS_DOWN: usize = 4;
/// Below this alpha (its paint's, times `globalAlpha`) a fill is a wash:
/// a sparse floor of dots rather than a solid area.
const WASH_ALPHA: f32 = 0.5;
/// Below this alpha a stroke or a fill is a texture (hatching, a hairline
/// or a track at a few percent): a dot shows at full strength, so its
/// dots would bury the marks over them. It is drawn as a hairline in the
/// faintest gray under the other marks: a stroke along its path, a fill
/// along its outline.
const TEXTURE_ALPHA: f32 = 0.15;

/// How far below a row's top the alphabetic baseline sits, in rows.
const ALPHABETIC_BASELINE: f32 = 0.75;
const BOLD_WEIGHT: u16 = 600;

/// What a canvas view draws: its drawing and the current values of the
/// animated slots it reads, which the native animator writes.
pub(crate) struct CanvasView {
    pub(crate) drawing: Arc<Drawing>,
    pub(crate) args: Vec<Option<AnimationValue>>,
}

impl CanvasView {
    pub(crate) fn new(drawing: Arc<Drawing>) -> Self {
        Self {
            drawing,
            args: Vec::new(),
        }
    }

    fn number(&self, n: Num) -> f32 {
        n.get(|slot| {
            self.args
                .get(slot as usize)
                .copied()
                .flatten()
                .map_or(0.0, AnimationValue::number)
        })
    }

    /// The color a paint draws: a gradient by its middle stop, an animated
    /// color by its current value (transparent until it has one).
    fn color(&self, paint: &Paint) -> nsh_core::Color {
        match paint {
            Paint::Color(color) => *color,
            Paint::Slot(slot) => match self.args.get(*slot as usize).copied().flatten() {
                Some(AnimationValue::Color(color)) => nsh_core::Color(color),
                _ => nsh_core::Color::TRANSPARENT,
            },
            Paint::Gradient(gradient) => gradient
                .stops
                .get(gradient.stops.len() / 2)
                .map_or(nsh_core::Color::TRANSPARENT, |(_, color)| *color),
        }
    }
}

/// Whether Cell (`x`, `y`) holds a text's glyph or stands beside one on
/// its row: a dot there would touch the word.
fn by_text(buffer: &Buffer, text_cells: &[bool], x: u16, y: u16) -> bool {
    let area = buffer.area;
    let glyph = |x: u16| {
        let at = buffer.index_of(x, y);
        text_cells.get(at).copied().unwrap_or(false)
            && buffer.content[at]
                .symbol()
                .chars()
                .any(|c| !c.is_whitespace())
    };
    let at = buffer.index_of(x, y);
    text_cells.get(at).copied().unwrap_or(false)
        || (x > area.x && glyph(x - 1))
        || (x + 1 < area.right() && glyph(x + 1))
}

/// Draws `canvas` into the `visible` Cells of a view whose Cells are
/// `bounds`, in the paints' own colors over `ground`. A text drawn before
/// it (a value in a ring's middle) keeps its Cells and a Cell clear each
/// side, as the canvas's own labels do.
#[allow(clippy::too_many_arguments)]
pub(crate) fn draw(
    canvas: &CanvasView,
    buffer: &mut Buffer,
    text_cells: &[bool],
    bounds: CellBounds,
    visible: Rect,
    cells: CellSize,
    ground: Ground,
    hues: &mut palette::Hues,
) {
    if visible.is_empty() {
        return;
    }
    let mut replay = Replay::new(canvas, bounds, visible, cells, ground);
    replay.hues = std::mem::take(hues);
    for op in &canvas.drawing.ops {
        replay.op(op);
    }
    let Replay {
        dots,
        mut labels,
        hues: kept,
        ..
    } = replay;
    *hues = kept;
    let mut scratch = Buffer::empty(Rect::new(0, 0, visible.width, visible.height));
    Canvas::default()
        .marker(Marker::Braille)
        .paint(|cx| cx.draw(&dots))
        .render(scratch.area, &mut scratch);
    // The Canvas widget resets the background of its whole area; copying
    // only its symbols, in each Cell's latest ink, keeps what lies under it.
    let inks = dots.latest();
    for y in 0..visible.height {
        for x in 0..visible.width {
            let dot = &scratch[(x, y)];
            if dot.symbol() != " " && !by_text(buffer, text_cells, visible.x + x, visible.y + y) {
                let symbol = dot.symbol().to_owned();
                let cell = &mut buffer[(visible.x + x, visible.y + y)];
                cell.set_symbol(&symbol);
                if let Some((style, _)) =
                    inks[usize::from(y) * usize::from(visible.width) + usize::from(x)]
                {
                    cell.set_style(style);
                }
            }
        }
    }
    let mut order: Vec<_> = (0..labels.len()).collect();
    order.sort_by(|&a, &b| {
        labels[a]
            .run
            .cells
            .top
            .cmp(&labels[b].run.cells.top)
            .then_with(|| {
                labels[a]
                    .run
                    .points
                    .left()
                    .0
                    .total_cmp(&labels[b].run.points.left().0)
            })
    });
    let mut placed = Vec::with_capacity(order.len());
    for index in order {
        labels[index].run = labels[index].run.separated(placed.iter());
        placed.push(labels[index].run);
    }
    // A label stands apart from the marks: the Cell before and after it
    // shows no dots, so its digits never read as part of a line.
    for label in &labels {
        let row = label.run.cells.top;
        let width: i32 = label.text.graphemes(true).map(|g| g.width() as i32).sum();
        let left = label.run.cells.left;
        for column in [left - 1, left + width] {
            if (0..i32::from(visible.width)).contains(&column)
                && (0..i32::from(visible.height)).contains(&row)
            {
                let (x, y) = (column as u16, row as u16);
                // Only its own dots: what lies under the canvas stays.
                if scratch[(x, y)].symbol() != " " {
                    buffer[(visible.x + x, visible.y + y)].set_symbol(" ");
                }
            }
        }
    }
    for label in labels {
        let row = label.run.cells.top as u16;
        let mut offset = 0;
        for grapheme in label.text.graphemes(true) {
            let column = label.run.cells.left.saturating_add(offset);
            offset = offset.saturating_add(grapheme.width() as i32);
            if !(0..i32::from(visible.width)).contains(&column) {
                continue;
            }
            let column = column as u16;
            let probe = (usize::from(row) * DOTS_DOWN + DOTS_DOWN / 2) * dots.width
                + usize::from(column) * DOTS_ACROSS
                + DOTS_ACROSS / 2;
            if label.clip.as_ref().is_some_and(|clip| !clip[probe]) {
                continue;
            }
            let mut style = label.ink;
            if label.bold {
                style = style.add_modifier(Modifier::BOLD);
            }
            if label.italic {
                style = style.add_modifier(Modifier::ITALIC);
            }
            buffer.set_stringn(
                visible.x + column,
                visible.y + row,
                grapheme,
                usize::from(visible.width - column),
                style,
            );
        }
    }
}

/// The bounds `[left, top, right, bottom]` of `outline`'s points; `None`
/// when it has none.
fn extent(outline: &Outline) -> Option<[f32; 4]> {
    let mut points = outline.subpaths.iter().flat_map(|s| s.points.iter());
    let &[x, y] = points.next()?;
    Some(points.fold([x, y, x, y], |[l, t, r, b], &[x, y]| {
        [l.min(x), t.min(y), r.max(x), b.max(y)]
    }))
}

/// The dots of the visible Cells, each with its palette ink and when it was
/// painted (the Cell takes the ink of its latest dot).
struct Dots {
    width: usize,
    height: usize,
    /// The canvas point at the top left of the first dot.
    origin: [f32; 2],
    /// A dot's size in points.
    step: [f32; 2],
    inks: Vec<Option<(Style, u32)>>,
    painted: u32,
}

impl Dots {
    fn center_y(&self, row: usize) -> f32 {
        self.origin[1] + (row as f32 + 0.5) * self.step[1]
    }

    fn paint(&mut self, index: usize, ink: Style) {
        self.painted += 1;
        self.inks[index] = Some((ink, self.painted));
    }

    /// Paints a dot that every other in its Cell outranks (a texture's):
    /// only where no dot is, and its Cell keeps any other dot's ink.
    fn paint_under(&mut self, index: usize, ink: Style) {
        if self.inks[index].is_none() {
            self.inks[index] = Some((ink, 0));
        }
    }

    /// The ink of each Cell's latest dot, row by row.
    fn latest(&self) -> Vec<Option<(Style, u32)>> {
        let columns = self.width / DOTS_ACROSS;
        let mut latest: Vec<Option<(Style, u32)>> = vec![None; columns * (self.height / DOTS_DOWN)];
        for (index, dot) in self.inks.iter().enumerate() {
            if let Some((ink, painted)) = *dot {
                let cell =
                    index / self.width / DOTS_DOWN * columns + index % self.width / DOTS_ACROSS;
                if latest[cell].is_none_or(|(_, last)| painted > last) {
                    latest[cell] = Some((ink, painted));
                }
            }
        }
        latest
    }

    /// Calls `visit` with each dot whose center `outline` holds by `rule`.
    fn inside(&self, outline: &Outline, rule: FillRule, mut visit: impl FnMut(usize)) {
        let mut spans = Vec::new();
        for row in 0..self.height {
            outline.spans(self.center_y(row), rule, &mut spans);
            for &(start, end) in &spans {
                let first = ((start - self.origin[0]) / self.step[0] - 0.5)
                    .ceil()
                    .max(0.0);
                let after = ((end - self.origin[0]) / self.step[0] - 0.5)
                    .ceil()
                    .min(self.width as f32);
                if first < after {
                    for column in first as usize..after as usize {
                        visit(row * self.width + column);
                    }
                }
            }
        }
    }

    /// Calls `visit` with each dot the segment from `a` to `b` (view
    /// points) passes through, and how far along the segment the dot's
    /// center lies, in points (where dash patterns sample it).
    fn trace(&self, a: [f32; 2], b: [f32; 2], mut visit: impl FnMut(usize, f32)) {
        let to_dots = |p: [f32; 2]| {
            [
                (p[0] - self.origin[0]) / self.step[0],
                (p[1] - self.origin[1]) / self.step[1],
            ]
        };
        let Some((from, to)) = clip_segment(
            to_dots(a),
            to_dots(b),
            [0.0, 0.0],
            [self.width as f32, self.height as f32],
        ) else {
            return;
        };
        let direction = [b[0] - a[0], b[1] - a[1]];
        let length = distance(a, b);
        let steps = (to[0] - from[0])
            .abs()
            .max((to[1] - from[1]).abs())
            .ceil()
            .max(1.0) as usize;
        // Each axis is half open, as a pixel grid is: a segment that ends
        // on a dot's left or top edge (a line to the plot's right edge,
        // which is the next Cell's start) stops before that dot.
        let dot = |x: f32, from: f32, to: f32| {
            let floor = x.floor();
            if x == from.max(to) && from != to && floor == x {
                floor - 1.0
            } else {
                floor
            }
        };
        for step in 0..=steps {
            let t = step as f32 / steps as f32;
            let at = |axis: usize| match step == steps {
                true => to[axis],
                false => from[axis] + (to[axis] - from[axis]) * t,
            };
            let column = dot(at(0), from[0], to[0]);
            let row = dot(at(1), from[1], to[1]);
            if column < 0.0
                || row < 0.0
                || column as usize >= self.width
                || row as usize >= self.height
            {
                continue;
            }
            let along = if length > 0.0 {
                let center = [
                    self.origin[0] + (column + 0.5) * self.step[0],
                    self.origin[1] + (row + 0.5) * self.step[1],
                ];
                (((center[0] - a[0]) * direction[0] + (center[1] - a[1]) * direction[1]) / length)
                    .clamp(0.0, length)
            } else {
                0.0
            };
            visit(row as usize * self.width + column as usize, along);
        }
    }
}

/// The part of the segment from `a` to `b` inside the box `min`..`max`
/// (Liang–Barsky).
fn clip_segment(
    a: [f32; 2],
    b: [f32; 2],
    min: [f32; 2],
    max: [f32; 2],
) -> Option<([f32; 2], [f32; 2])> {
    if !(a[0].is_finite() && a[1].is_finite() && b[0].is_finite() && b[1].is_finite()) {
        return None;
    }
    let delta = [b[0] - a[0], b[1] - a[1]];
    let (mut enter, mut exit) = (0.0f32, 1.0f32);
    for axis in 0..2 {
        for (p, q) in [
            (-delta[axis], a[axis] - min[axis]),
            (delta[axis], max[axis] - a[axis]),
        ] {
            if p == 0.0 {
                if q < 0.0 {
                    return None;
                }
            } else {
                let t = q / p;
                if p < 0.0 {
                    enter = enter.max(t);
                } else {
                    exit = exit.min(t);
                }
            }
        }
    }
    (enter <= exit).then(|| {
        let at = |t: f32| [a[0] + delta[0] * t, a[1] + delta[1] * t];
        (at(enter), at(exit))
    })
}

impl Shape for Dots {
    fn draw(&self, painter: &mut Painter) {
        for (index, dot) in self.inks.iter().enumerate() {
            if dot.is_some() {
                painter.paint(index % self.width, index / self.width, Color::Reset);
            }
        }
    }
}

/// A canvas text call, kept together while its gap to neighbouring calls projects to Cells.
struct Label<'a> {
    run: TextRun,
    text: &'a str,
    clip: Option<Rc<[bool]>>,
    ink: Style,
    bold: bool,
    italic: bool,
}

#[derive(Clone)]
struct State {
    matrix: Matrix,
    fill: Paint,
    stroke: Paint,
    alpha: f32,
    dash: Arc<[nsh_core::Points]>,
    dash_offset: f32,
    align: CanvasTextAlign,
    baseline: CanvasTextBaseline,
    bold: bool,
    italic: bool,
    /// The dots inside every clip in effect; `None` is no clip.
    clip: Option<Rc<[bool]>>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            matrix: IDENTITY,
            fill: Paint::Color(nsh_core::Color::BLACK),
            stroke: Paint::Color(nsh_core::Color::BLACK),
            alpha: 1.0,
            dash: Arc::from([]),
            dash_offset: 0.0,
            align: CanvasTextAlign::default(),
            baseline: CanvasTextBaseline::default(),
            bold: false,
            italic: false,
            clip: None,
        }
    }
}

struct Replay<'a> {
    canvas: &'a CanvasView,
    dots: Dots,
    labels: Vec<Label<'a>>,
    cells: CellSize,
    /// The visible Cells' offset from the canvas's first Cell.
    offset: [i32; 2],
    ground: Ground,
    base: Matrix,
    state: State,
    saved: Vec<State>,
    path: Outline,
    /// The frame's canvas colors at 16 colors, kept apart.
    hues: palette::Hues,
}

impl<'a> Replay<'a> {
    fn new(
        canvas: &'a CanvasView,
        bounds: CellBounds,
        visible: Rect,
        cells: CellSize,
        ground: Ground,
    ) -> Self {
        let offset = [
            i32::from(visible.x) - bounds.left,
            i32::from(visible.y) - bounds.top,
        ];
        let (cell_width, cell_height) = (cells.width().0, cells.height().0);
        let width = usize::from(visible.width) * DOTS_ACROSS;
        let height = usize::from(visible.height) * DOTS_DOWN;
        Self {
            canvas,
            dots: Dots {
                width,
                height,
                origin: [
                    offset[0] as f32 * cell_width,
                    offset[1] as f32 * cell_height,
                ],
                step: [
                    cell_width / DOTS_ACROSS as f32,
                    cell_height / DOTS_DOWN as f32,
                ],
                inks: vec![None; width * height],
                painted: 0,
            },
            labels: Vec::new(),
            cells,
            offset,
            ground,
            base: IDENTITY,
            state: State::default(),
            saved: Vec::new(),
            path: Outline::default(),
            hues: palette::Hues::default(),
        }
    }

    fn n(&self, n: Num) -> f32 {
        self.canvas.number(n)
    }

    fn transform(&mut self, by: Matrix) {
        self.state.matrix = multiply(self.state.matrix, by);
    }

    fn outline(&self, path: &[PathOp]) -> Outline {
        Outline::of(path, &self.state.matrix, &|n| self.n(n))
    }

    /// A paint's color at the terminal's depth, its alpha including `globalAlpha`; `None`
    /// draws nothing.
    fn ink(&mut self, paint: &Paint) -> Option<Style> {
        let color = self.canvas.color(paint);
        let alpha = ((color.0 & 255) as f32 * self.state.alpha).round() as u32;
        (alpha > 0).then(|| {
            self.hues
                .paint(nsh_core::Color(color.0 & !255 | alpha), self.ground)
        })
    }

    fn clipped_out(&self, index: usize) -> bool {
        self.state.clip.as_ref().is_some_and(|clip| !clip[index])
    }

    fn fill(&mut self, outline: &Outline, rule: FillRule) {
        let paint = self.state.fill.clone();
        let Some(ink) = self.ink(&paint) else {
            return;
        };
        // A translucent fill is a wash under the marks (an area beneath
        // its curve): solid, its dots would merge with the line drawn
        // over it into one block. It sets a sparse floor of dots instead,
        // one at the bottom of every other dot column, which a stroke
        // over it still reads through.
        let alpha = (self.canvas.color(&paint).0 & 255) as f32 / 255.0 * self.state.alpha;
        // Fainter still (a ring's track at a few percent) its floor of
        // dots would only scatter round the marks and the text over them:
        // its outline is a hairline in the faintest gray instead, so a
        // track still shows the full scale.
        if alpha < TEXTURE_ALPHA {
            let faint = self.faint();
            self.trace(outline, faint, None, true);
            return;
        }
        let wash = alpha < WASH_ALPHA;
        let width = self.dots.width;
        let mut inside = Vec::new();
        self.dots.inside(outline, rule, |index| inside.push(index));
        // A fill that holds no dot's center (a dot matrix's 1.5pt squares,
        // a 1pt rule) would draw nothing, or only where it happens to
        // cover a center: the marks of a regular grid would come and go
        // with their phase. It takes the dots along its middle instead,
        // the one under it when it is smaller than a dot.
        if inside.is_empty() {
            if let Some([left, top, right, bottom]) = extent(outline) {
                let [across, down] = self.dots.step;
                let (a, b) = if right - left <= across && bottom - top <= down {
                    // Smaller than a dot: the one under its middle.
                    let middle = [(left + right) / 2.0, (top + bottom) / 2.0];
                    (middle, middle)
                } else if right - left >= bottom - top {
                    let y = (top + bottom) / 2.0;
                    ([left, y], [right, y])
                } else {
                    let x = (left + right) / 2.0;
                    ([x, top], [x, bottom])
                };
                self.dots.trace(a, b, |index, _| inside.push(index));
                inside.sort_unstable();
                inside.dedup();
            }
            for index in inside {
                if !self.clipped_out(index) {
                    self.dots.paint(index, ink);
                }
            }
            return;
        }
        for index in inside {
            let sparse =
                (index % width).is_multiple_of(2) && index / width % DOTS_DOWN == DOTS_DOWN - 1;
            if !self.clipped_out(index) && (!wash || sparse) {
                self.dots.paint(index, ink);
            }
        }
    }

    fn stroke(&mut self, outline: &Outline) {
        let paint = self.state.stroke.clone();
        let alpha = (self.canvas.color(&paint).0 & 255) as f32 / 255.0 * self.state.alpha;
        let Some(ink) = self.ink(&paint) else {
            return;
        };
        // A stroke is drawn however faint (a track, a hairline): below
        // `TEXTURE_ALPHA` in the faintest gray, under what else shares
        // its Cells, so it never buries the marks over it.
        let under = alpha < TEXTURE_ALPHA;
        let ink = if under { self.faint() } else { ink };
        // Its dashes and gaps two dots long at least, so it reads as
        // dashes, not as a dotted line.
        let dot = self.dots.step[0].max(self.dots.step[1]);
        let dash = Dash::new(
            &self.state.dash,
            self.state.dash_offset,
            mean_scale(&self.state.matrix),
        )
        .map(|dash| dash.at_least(2.0 * dot));
        self.trace(outline, ink, dash, under);
    }

    /// The faintest gray of the terminal: a texture's hairline.
    fn faint(&self) -> Style {
        match self.ground.ramp {
            Some(ramp) => Style::new().fg(ramp.faint()),
            None => Style::new().add_modifier(Modifier::DIM),
        }
    }

    /// Paints the dots along `outline` in `ink`, `dash` on; `under`, a
    /// dot only where none is and below every other in its Cell.
    fn trace(&mut self, outline: &Outline, ink: Style, dash: Option<Dash>, under: bool) {
        let mut on = Vec::new();
        for subpath in &outline.subpaths {
            let count = subpath.points.len();
            if count < 2 {
                continue;
            }
            let segments = if subpath.closed { count } else { count - 1 };
            let mut travelled = 0.0;
            for k in 0..segments {
                let (a, b) = (subpath.points[k], subpath.points[(k + 1) % count]);
                self.dots.trace(a, b, |index, along| {
                    if dash
                        .as_ref()
                        .is_none_or(|dash| dash.is_on(travelled + along))
                    {
                        on.push(index);
                    }
                });
                travelled += distance(a, b);
            }
        }
        // A dot is painted once per stroke, so translucent strokes do not
        // darken where segments meet.
        on.sort_unstable();
        on.dedup();
        for index in on {
            if !self.clipped_out(index) {
                if under {
                    self.dots.paint_under(index, ink);
                } else {
                    self.dots.paint(index, ink);
                }
            }
        }
    }

    fn clear(&mut self, outline: &Outline) {
        let mut inside = Vec::new();
        self.dots
            .inside(outline, FillRule::NonZero, |index| inside.push(index));
        for index in inside {
            if !self.clipped_out(index) {
                self.dots.inks[index] = None;
            }
        }
    }

    fn clip(&mut self, outline: &Outline, rule: FillRule) {
        let mut clip = vec![false; self.dots.inks.len()];
        self.dots.inside(outline, rule, |index| clip[index] = true);
        if let Some(previous) = &self.state.clip {
            for (inside, &before) in clip.iter_mut().zip(previous.iter()) {
                *inside &= before;
            }
        }
        self.state.clip = Some(clip.into());
    }

    fn text(&mut self, text: &'a str, x: f32, y: f32, max_width: Option<f32>, paint: Paint) {
        let Some(ink) = self.ink(&paint) else {
            return;
        };
        let (cell_width, cell_height) = (self.cells.width().0, self.cells.height().0);
        let max_cells = max_width.map_or(usize::MAX, |w| (w / cell_width).max(0.0) as usize);
        let mut text_end = 0;
        let mut width_cells = 0;
        for (start, grapheme) in text.grapheme_indices(true) {
            let width = grapheme.width();
            if width_cells + width > max_cells {
                break;
            }
            text_end = start + grapheme.len();
            width_cells += width;
        }
        let [anchor_x, anchor_y] = apply(&self.state.matrix, x, y);
        let text_width = width_cells as f32 * cell_width;
        let left = match self.state.align {
            CanvasTextAlign::Start | CanvasTextAlign::Left => anchor_x,
            CanvasTextAlign::Center => anchor_x - text_width / 2.0,
            CanvasTextAlign::End | CanvasTextAlign::Right => anchor_x - text_width,
        };
        let rows_above = match self.state.baseline {
            CanvasTextBaseline::Top | CanvasTextBaseline::Hanging => 0.0,
            CanvasTextBaseline::Middle => 0.5,
            CanvasTextBaseline::Alphabetic => ALPHABETIC_BASELINE,
            CanvasTextBaseline::Ideographic | CanvasTextBaseline::Bottom => 1.0,
        };
        let row = (anchor_y / cell_height - rows_above + 0.5).floor() as i32 - self.offset[1];
        let first_column = (left / cell_width + 0.5).floor() as i32 - self.offset[0];
        let rows = (self.dots.height / DOTS_DOWN) as i32;
        if !(0..rows).contains(&row) || width_cells == 0 {
            return;
        }
        self.labels.push(Label {
            run: TextRun {
                points: nsh_core::Bounds::new(
                    nsh_core::Point::new(
                        nsh_core::Points(left),
                        nsh_core::Points(anchor_y - rows_above * cell_height),
                    ),
                    nsh_core::Size::new(nsh_core::Points(text_width), self.cells.height()),
                ),
                cells: CellBounds {
                    left: first_column,
                    right: first_column.saturating_add(width_cells as i32),
                    top: row,
                    bottom: row + 1,
                },
            },
            text: &text[..text_end],
            clip: self.state.clip.clone(),
            ink,
            bold: self.state.bold,
            italic: self.state.italic,
        });
    }

    fn op(&mut self, op: &'a CanvasOp) {
        match op {
            CanvasOp::Save => self.saved.push(self.state.clone()),
            CanvasOp::Restore => {
                if let Some(state) = self.saved.pop() {
                    self.state = state;
                }
            }
            CanvasOp::Translate(x, y) => {
                self.transform([1.0, 0.0, 0.0, 1.0, self.n(*x), self.n(*y)]);
            }
            CanvasOp::Scale(x, y) => self.transform([self.n(*x), 0.0, 0.0, self.n(*y), 0.0, 0.0]),
            CanvasOp::Rotate(angle) => {
                let (sin, cos) = self.n(*angle).sin_cos();
                self.transform([cos, sin, -sin, cos, 0.0, 0.0]);
            }
            CanvasOp::Transform(m) => self.transform(m.map(|n| self.n(n))),
            CanvasOp::SetTransform(m) => {
                self.state.matrix = multiply(self.base, m.map(|n| self.n(n)))
            }
            CanvasOp::BeginPath => self.path = Outline::default(),
            CanvasOp::Path(op) => {
                let matrix = self.state.matrix;
                let canvas = self.canvas;
                self.path.add(op, &matrix, &|n| canvas.number(n));
            }
            CanvasOp::Fill(path, rule) => match path {
                Some(path) => self.fill(&self.outline(path), *rule),
                None => {
                    let current = std::mem::take(&mut self.path);
                    self.fill(&current, *rule);
                    self.path = current;
                }
            },
            CanvasOp::Stroke(path) => match path {
                Some(path) => self.stroke(&self.outline(path)),
                None => {
                    let current = std::mem::take(&mut self.path);
                    self.stroke(&current);
                    self.path = current;
                }
            },
            CanvasOp::Clip(path, rule) => match path {
                Some(path) => self.clip(&self.outline(path), *rule),
                None => {
                    let current = std::mem::take(&mut self.path);
                    self.clip(&current, *rule);
                    self.path = current;
                }
            },
            CanvasOp::FillRect(rect) => {
                let outline = Outline::rect(rect.map(|n| self.n(n)), &self.state.matrix);
                self.fill(&outline, FillRule::NonZero);
            }
            CanvasOp::StrokeRect(rect) => {
                let outline = Outline::rect(rect.map(|n| self.n(n)), &self.state.matrix);
                self.stroke(&outline);
            }
            CanvasOp::ClearRect(rect) => {
                let outline = Outline::rect(rect.map(|n| self.n(n)), &self.state.matrix);
                self.clear(&outline);
            }
            CanvasOp::FillStyle(paint) => self.state.fill = paint.clone(),
            CanvasOp::StrokeStyle(paint) => self.state.stroke = paint.clone(),
            CanvasOp::LineDash(segments) => self.state.dash = segments.clone(),
            CanvasOp::LineDashOffset(offset) => {
                let offset = self.n(*offset);
                if offset.is_finite() {
                    self.state.dash_offset = offset;
                }
            }
            CanvasOp::GlobalAlpha(alpha) => {
                let alpha = self.n(*alpha);
                // Canvas ignores values outside 0..1.
                if (0.0..=1.0).contains(&alpha) {
                    self.state.alpha = alpha;
                }
            }
            CanvasOp::Font(font) => {
                self.state.bold = font.weight >= BOLD_WEIGHT;
                self.state.italic = font.italic;
            }
            CanvasOp::TextAlign(align) => self.state.align = *align,
            CanvasOp::TextBaseline(baseline) => self.state.baseline = *baseline,
            CanvasOp::FillText {
                text,
                x,
                y,
                max_width,
            } => {
                let (x, y) = (self.n(*x), self.n(*y));
                let paint = self.state.fill.clone();
                self.text(text, x, y, max_width.map(|w| w.0), paint);
            }
            CanvasOp::StrokeText {
                text,
                x,
                y,
                max_width,
            } => {
                let (x, y) = (self.n(*x), self.n(*y));
                let paint = self.state.stroke.clone();
                self.text(text, x, y, max_width.map(|w| w.0), paint);
            }
            // Decorative features: a stroke is one dot wide, shadows,
            // compositing and images are left out.
            CanvasOp::LineWidth(_)
            | CanvasOp::LineCap(_)
            | CanvasOp::LineJoin(_)
            | CanvasOp::MiterLimit(_)
            | CanvasOp::Composite(_)
            | CanvasOp::ShadowColor(_)
            | CanvasOp::ShadowBlur(_)
            | CanvasOp::ShadowOffset(_)
            | CanvasOp::FontVariantNumeric(_)
            | CanvasOp::DrawImage { .. } => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{canvas::CanvasGradient, geometry::Percentage};

    use super::*;

    #[test]
    fn slots_and_gradients_resolve_to_one_color() {
        let mut canvas = CanvasView::new(Arc::default());
        canvas.args = vec![None, Some(AnimationValue::Color(0x11223344))];
        assert_eq!(canvas.color(&Paint::Slot(1)), nsh_core::Color(0x11223344));
        assert_eq!(canvas.color(&Paint::Slot(0)), nsh_core::Color::TRANSPARENT);
        let mut gradient = CanvasGradient::linear(Default::default(), Default::default());
        gradient.stops = [0xff0000ff, 0x00ff00ff, 0x0000ffff]
            .into_iter()
            .enumerate()
            .map(|(i, color)| (Percentage(i as f32 / 2.0), nsh_core::Color(color)))
            .collect();
        assert_eq!(
            canvas.color(&Paint::Gradient(Arc::new(gradient))),
            nsh_core::Color(0x00ff00ff)
        );
        canvas.args = vec![Some(AnimationValue::Number(7.0))];
        assert_eq!(canvas.number(Num::Slot(0)), 7.0);
        assert_eq!(canvas.number(Num::Slot(3)), 0.0);
    }

    #[test]
    fn segments_are_clipped_to_the_dot_grid() {
        let (from, to) =
            clip_segment([-10.0, 5.0], [30.0, 5.0], [-1.0, -1.0], [20.0, 10.0]).unwrap();
        assert_eq!([from[0], to[0]], [-1.0, 20.0]);
        assert!(clip_segment([-10.0, 50.0], [30.0, 50.0], [-1.0, -1.0], [20.0, 10.0]).is_none());
    }

    #[test]
    fn a_segment_to_a_dots_edge_stops_before_that_dot() {
        let dots = Dots {
            width: 8,
            height: 4,
            origin: [0.0, 0.0],
            step: [4.0, 4.0],
            inks: vec![None; 32],
            painted: 0,
        };
        let lit = |a: [f32; 2], b: [f32; 2]| {
            let mut lit = Vec::new();
            dots.trace(a, b, |index, _| lit.push(index));
            lit.sort_unstable();
            lit.dedup();
            lit
        };
        // Across four dots' width from the left edge: those four, not the
        // fifth, whose left edge the segment ends on, either way it runs.
        assert_eq!(lit([0.0, 2.0], [16.0, 2.0]), vec![0, 1, 2, 3]);
        assert_eq!(lit([16.0, 2.0], [0.0, 2.0]), vec![0, 1, 2, 3]);
        // Down to a row's top edge: the rows above it.
        assert_eq!(lit([2.0, 0.0], [2.0, 8.0]), vec![0, 8]);
        // Ending inside a dot lights it.
        assert_eq!(lit([0.0, 2.0], [17.0, 2.0]), vec![0, 1, 2, 3, 4]);
    }
}
