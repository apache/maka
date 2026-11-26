//! Selectable views (`View`'s `selectable`, a selectable `TextView`) under
//! the mouse: a drag that starts in one selects across its texts, as the
//! desktop backends and the web do, and the view hears `onSelectionChange`.
//! The logic is [`nsh_core::selection::SelectionModel`]'s, the backends'
//! own; this module lists a view's texts for it ([`Texts`]) with
//! [`nsh_core::ApproxTextEngine`]'s geometry: characters `0.55 ×` the font
//! size wide from the start of their line, lines as tall as the text's line
//! height, wrapped at the content box's width.

use std::{ops::Range, sync::Arc};

use nsh_core::{
    AttributedText, Bounds, EventKind, EventPayload, NodeId, PayloadValue, Point, Points,
    geometry::{point, px, size},
    selection::{SelectionModel, SelectionTexts},
};

use super::Headless;

/// How far (points) the mouse moves before a press selects, as the macOS
/// backend's.
const SLOP: f32 = 3.0;
/// The same over a press target (links, `onPress`).
const SLOP_PRESS: f32 = 10.0;

/// The selection of the selectable view last pressed.
pub(super) struct AreaSelection {
    area: NodeId,
    model: SelectionModel,
    /// The pressed mouse moved far enough to select.
    dragging: bool,
    /// The press began over a press target.
    over_press: bool,
    /// What its `onSelectionChange` last heard.
    reported: Selected,
}

/// What `onSelectionChange` reports: the selected text, where it starts and
/// the box around it in the view.
#[derive(Debug, Clone, Default, PartialEq)]
struct Selected {
    text: String,
    start: u32,
    bounds: Option<Bounds<Points>>,
}

/// One text of a selectable view.
struct Text {
    id: NodeId,
    text: Arc<AttributedText>,
    frame: Bounds<Points>,
    advance: f32,
    line: f32,
    /// Its lines: where each starts (UTF-16 units) and its characters'
    /// UTF-16 offsets after the first, a line break left out.
    lines: Vec<Vec<u32>>,
    /// The list marker beside it (`selection::marker_of`).
    marker: Option<String>,
}

impl Text {
    fn new(id: NodeId, text: Arc<AttributedText>, frame: Bounds<Points>) -> Self {
        let (font, line) = text
            .spans
            .iter()
            .fold((px(14.0), Points::ZERO), |(f, l), s| {
                (
                    f.max(s.style.font_size.max(px(1.0))),
                    l.max(s.style.approx_line_height()),
                )
            });
        let line = if line > Points::ZERO {
            line
        } else {
            font * 1.2
        };
        let advance = font.0 * 0.55;
        let per_line = match text.no_wrap {
            true => usize::MAX,
            false => ((frame.size.width.0 / advance).floor() as usize).max(1),
        };
        let mut lines = Vec::new();
        let mut offset = 0u32;
        for part in text.text.split('\n') {
            let mut current = vec![offset];
            for c in part.chars() {
                if current.len() > per_line {
                    let start = *current.last().unwrap_or(&offset);
                    lines.push(std::mem::replace(&mut current, vec![start]));
                }
                offset += c.len_utf16() as u32;
                current.push(offset);
            }
            lines.push(current);
            offset += 1;
        }
        Self {
            id,
            text,
            frame,
            advance,
            line: line.0,
            lines,
            marker: None,
        }
    }

    /// Line `row`'s offsets, the last line's below the text.
    fn row(&self, y: f32) -> (usize, &[u32]) {
        let row = ((y / self.line).floor().max(0.0) as usize).min(self.lines.len() - 1);
        (row, &self.lines[row])
    }
}

/// The texts of a selectable view at one moment, in document order.
struct Texts(Vec<Text>);

impl SelectionTexts for Texts {
    fn len(&self) -> usize {
        self.0.len()
    }

    fn content(&self, i: usize) -> &str {
        &self.0[i].text.text
    }

    fn copied(&self, i: usize, range: Range<u32>) -> String {
        self.0[i].text.copied_text(range)
    }

    fn frame(&self, i: usize) -> Bounds<Points> {
        self.0[i].frame
    }

    fn offset_at(&self, i: usize, p: Point<Points>) -> u32 {
        let text = &self.0[i];
        let (_, offsets) = text.row(p.y.0 - text.frame.origin.y.0);
        let column = ((p.x.0 - text.frame.origin.x.0) / text.advance)
            .round()
            .max(0.0) as usize;
        offsets[column.min(offsets.len() - 1)]
    }

    fn key(&self, i: usize) -> u64 {
        u64::from(self.0[i].id)
    }

    fn marker(&self, i: usize) -> Option<&str> {
        self.0[i].marker.as_deref()
    }

    fn range_bounds(&self, i: usize, range: Range<u32>) -> Option<Bounds<Points>> {
        let text = &self.0[i];
        let origin = text.frame.origin;
        text.lines
            .iter()
            .enumerate()
            .filter_map(|(row, offsets)| {
                let from = offsets.iter().position(|&o| o >= range.start)?;
                let to = offsets.iter().rposition(|&o| o <= range.end)?;
                (from < to).then(|| {
                    Bounds::new(
                        point(
                            origin.x + Points(from as f32 * text.advance),
                            origin.y + Points(row as f32 * text.line),
                        ),
                        size(Points((to - from) as f32 * text.advance), Points(text.line)),
                    )
                })
            })
            .reduce(|a, b| a.union(&b))
    }
}

impl Headless {
    fn area_texts(&self, area: NodeId) -> Texts {
        Texts(
            self.screen
                .area_texts(area)
                .into_iter()
                .map(|(id, text, frame, marker)| Text {
                    marker,
                    ..Text::new(id, text, frame)
                })
                .collect(),
        )
    }

    /// The mouse went down at `at` (root points) on `target`, `over_press`
    /// if a press target is under it: a selectable view around `target`
    /// puts the selection's anchor there (Shift held extends it), and a
    /// press anywhere else clears the selection. The selectable view, if
    /// any: the drag selects in it.
    pub(super) fn selection_down(
        &mut self,
        target: NodeId,
        at: Point<Points>,
        over_press: bool,
    ) -> Option<NodeId> {
        let area = self.screen.selection_area(target);
        if self.selection.as_ref().map(|s| s.area) != area {
            self.clear_selection();
        }
        let area = area?;
        let local = self.in_area(area, at)?;
        let texts = self.area_texts(area);
        let shift = self.held.shift;
        let selection = self.selection.get_or_insert_with(|| AreaSelection {
            area,
            model: SelectionModel::new(),
            dragging: false,
            over_press: false,
            reported: Selected::default(),
        });
        selection.over_press = over_press;
        selection.dragging = shift;
        selection.model.texts_changed(&texts);
        selection.model.press(&texts, local, 1, shift);
        self.report_area_selection(&texts);
        Some(area)
    }

    /// The pressed mouse moved by `by` from where it went down in `area`,
    /// to `at` (root points). True while the drag selects (past the slop):
    /// no press goes in then.
    pub(super) fn selection_drag(
        &mut self,
        area: NodeId,
        by: Point<Points>,
        at: Point<Points>,
    ) -> bool {
        let Some(local) = self.in_area(area, at) else {
            return false;
        };
        let Some(selection) = self.selection.as_mut().filter(|s| s.area == area) else {
            return false;
        };
        if !selection.dragging {
            let slop = if selection.over_press {
                SLOP_PRESS
            } else {
                SLOP
            };
            if by.x.0.hypot(by.y.0) <= slop {
                return false;
            }
            selection.dragging = true;
        }
        let texts = self.area_texts(area);
        let Some(selection) = self.selection.as_mut() else {
            return false;
        };
        if selection.model.drag(&texts, local) {
            self.report_area_selection(&texts);
        }
        true
    }

    /// The mouse pressed in a selectable view went up.
    pub(super) fn selection_up(&mut self) {
        if let Some(selection) = &mut self.selection {
            selection.dragging = false;
        }
    }

    /// `ref.clearSelection()` on view `id`: clears the selection when its
    /// selectable view is `id`, inside it or around it.
    pub(super) fn clear_selection_in(&mut self, id: NodeId) {
        let Some(area) = self.selection.as_ref().map(|s| s.area) else {
            return;
        };
        if self.screen.within(area, id) || self.screen.within(id, area) {
            self.clear_selection();
        }
    }

    /// Clears the selection; its view hears it if it heard of one.
    fn clear_selection(&mut self) {
        let Some(selection) = self.selection.take() else {
            return;
        };
        if selection.reported != Selected::default() {
            self.send_selection(selection.area, Selected::default());
        }
    }

    /// `at` (root points) in `area`'s points.
    fn in_area(&self, area: NodeId, at: Point<Points>) -> Option<Point<Points>> {
        let origin = self.screen.bounds_in_root(area)?.origin;
        Some(point(at.x - origin.x, at.y - origin.y))
    }

    /// Reports the selection to its view's `onSelectionChange` when it
    /// changed.
    fn report_area_selection(&mut self, texts: &Texts) {
        let Some(selection) = &mut self.selection else {
            return;
        };
        let selected = if selection.model.is_empty() {
            Selected::default()
        } else {
            Selected {
                text: selection.model.text(texts),
                start: selection.model.start_offset(texts),
                bounds: selection.model.selected_bounds(texts),
            }
        };
        if selected == selection.reported {
            return;
        }
        selection.reported.clone_from(&selected);
        let area = selection.area;
        self.send_selection(area, selected);
    }

    fn send_selection(&self, area: NodeId, selected: Selected) {
        let mut fields = vec![
            ("text", PayloadValue::Str(selected.text)),
            ("start", PayloadValue::Number(f64::from(selected.start))),
        ];
        if let Some(bounds) = selected.bounds {
            fields.push(("bounds", PayloadValue::Bounds(bounds)));
        }
        self.send(area, EventKind::SelectionChange, EventPayload::Map(fields));
    }
}
