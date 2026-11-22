//! A surface's selection uses the core range model and the exact glyphs painted on Cells.

use std::time::{Duration, Instant};

use nsh_core::{
    Bounds, EventKind, NodeId, Point, Points,
    selection::{SelectionModel, SelectionTexts},
};
use ratatui_core::{
    buffer::Buffer,
    layout::{Position, Rect},
    style::Modifier,
};

use crate::{
    CellSize, MouseButton, MouseInput, MouseKind,
    geometry::CellBounds,
    mount::Mounter,
    render::{Geometry, Hit},
    text::CellLayout,
};

/// What a selection reads of the last frame drawn: the surface's `area` and
/// Cell size, the views that take the pointer (`hits`), every view's Cells
/// (`geometry`) and the tree.
#[derive(Clone, Copy)]
pub(crate) struct Scene<'a> {
    pub(crate) area: Rect,
    pub(crate) cells: CellSize,
    pub(crate) hits: &'a [Hit],
    pub(crate) geometry: &'a [Geometry],
    pub(crate) tree: &'a Mounter,
}

#[derive(Default)]
pub(crate) struct Selection {
    root: Option<NodeId>,
    model: SelectionModel,
    dragging: bool,
    taking: bool,
    start: Point<Points>,
    /// Where a drag last was, in points and in the terminal's Cells.
    point: Point<Points>,
    cell: Position,
    /// When a drag held past its scroll view's edge scrolls it again.
    next: Option<Instant>,
    /// The scroll moved under the drag: extend it at `point` once laid out again.
    follow: bool,
    /// The selectable view and selected text last reported to its
    /// `onSelectionChange` (kept when the selection clears).
    reported: Option<(NodeId, String)>,
}

/// How often a drag held past a scroll view's edge scrolls it, by as many
/// Cells as the pointer is past the edge.
const AUTOSCROLL_INTERVAL: Duration = Duration::from_millis(50);

struct Texts<'a> {
    tree: &'a Mounter,
    geometry: Vec<&'a Geometry>,
}

impl<'a> Texts<'a> {
    fn new(tree: &'a Mounter, geometry: &'a [Geometry], root: NodeId) -> Self {
        let geometry = geometry
            .iter()
            .filter(|g| {
                crate::keyboard::contains(tree, root, g.id)
                    && tree.get(g.id).is_some_and(|view| {
                        view.text.is_some()
                            && view
                                .text_content
                                .as_ref()
                                .is_some_and(|text| text.selectable != Some(false))
                    })
            })
            .collect();
        Self { tree, geometry }
    }

    fn layout(&self, i: usize) -> &CellLayout {
        self.tree
            .get(self.geometry[i].id)
            .unwrap()
            .text
            .as_ref()
            .unwrap()
            .0
            .downcast::<CellLayout>()
            .unwrap()
    }
}

impl SelectionTexts for Texts<'_> {
    fn len(&self) -> usize {
        self.geometry.len()
    }
    fn key(&self, i: usize) -> u64 {
        u64::from(self.geometry[i].id)
    }
    fn content(&self, i: usize) -> &str {
        &self
            .tree
            .get(self.geometry[i].id)
            .unwrap()
            .text_content
            .as_ref()
            .unwrap()
            .text
    }
    fn copied(&self, i: usize, range: std::ops::Range<u32>) -> String {
        self.tree
            .get(self.geometry[i].id)
            .unwrap()
            .text_content
            .as_ref()
            .unwrap()
            .copied_text(range)
    }
    fn frame(&self, i: usize) -> Bounds<Points> {
        self.geometry[i].text_frame.expect("text geometry")
    }
    fn continues(&self, i: usize) -> bool {
        self.tree
            .get(self.geometry[i].id)
            .is_some_and(|view| view.props.continues_text)
    }
    fn offset_at(&self, i: usize, point: Point<Points>) -> u32 {
        let point = point - self.frame(i).origin;
        let glyphs = &self.layout(i).glyphs;
        let row = glyphs
            .iter()
            .min_by(|(a, _), (b, _)| {
                let distance = |bounds: &Bounds<Points>| {
                    (point.y - bounds.bottom())
                        .max(Points::ZERO)
                        .max(bounds.top() - point.y)
                        .0
                };
                distance(a).total_cmp(&distance(b))
            })
            .map(|(bounds, _)| bounds.top());
        let mut end = 0;
        for (bounds, range) in glyphs
            .iter()
            .filter(|(bounds, _)| Some(bounds.top()) == row)
        {
            if range.is_empty() {
                continue;
            }
            if point.x <= bounds.left() + bounds.size.width / 2.0 {
                return range.start;
            }
            end = range.end;
        }
        end
    }
}

impl Selection {
    /// A selection area holds the pointer's last selection.
    pub(crate) fn is_active(&self) -> bool {
        self.root.is_some()
    }

    pub(crate) fn clear(&mut self) {
        *self = Self {
            reported: self.reported.take(),
            ..Self::default()
        };
    }

    /// The `onSelectionChange` events due since the last call: the selected
    /// text of the selectable view with the selection when it changed, and
    /// `""` for one that lost a non-empty selection (unless it is gone).
    /// `geometry` is the last frame's.
    pub(crate) fn changes(
        &mut self,
        tree: &Mounter,
        geometry: &[Geometry],
    ) -> Vec<(NodeId, String, u32)> {
        let mut out = Vec::new();
        let current = self.root.filter(|&root| {
            tree.get(root).is_some_and(|view| {
                view.props.selectable_view && view.events.contains(EventKind::SelectionChange)
            })
        });
        if let Some((id, text)) = &self.reported
            && Some(*id) != current
        {
            if !text.is_empty() && tree.get(*id).is_some() {
                out.push((*id, String::new(), 0));
            }
            self.reported = None;
        }
        if let Some(root) = current {
            let (text, start) = if self.model.is_empty() {
                (String::new(), 0)
            } else {
                let texts = Texts::new(tree, geometry, root);
                (self.model.text(&texts), self.model.start_offset(&texts))
            };
            let last = self.reported.as_ref().map_or("", |(_, t)| t.as_str());
            if text != last {
                out.push((root, text.clone(), start));
            }
            self.reported = Some((root, text));
        }
        out
    }

    pub(crate) fn handle(&mut self, mouse: MouseInput, scene: Scene<'_>, clicks: u32) -> bool {
        let Scene {
            area,
            cells,
            hits,
            geometry,
            tree,
        } = scene;
        let scope = crate::navigation::focus_scope(tree);
        if self
            .root
            .is_some_and(|root| !crate::keyboard::contains(tree, scope, root))
        {
            self.clear();
        }
        let position = Position::new(mouse.column, mouse.row);
        let point = Point::new(
            cells.width() * (f32::from(mouse.column) - f32::from(area.x) + 0.5),
            cells.height() * (f32::from(mouse.row) - f32::from(area.y) + 0.5),
        );
        if self.dragging
            && matches!(
                mouse.kind,
                MouseKind::Move | MouseKind::Up(MouseButton::Left)
            )
        {
            self.point = point;
            self.cell = position;
            let delta = point - self.start;
            if !self.taking && delta.x.abs().max(delta.y.abs()) > nsh_core::input::PRESS_SLOP {
                self.taking = true;
            }
            if !self.taking {
                self.dragging = !matches!(mouse.kind, MouseKind::Up(_));
                return false;
            }
            if let Some(root) = self.root {
                let texts = Texts::new(tree, geometry, root);
                self.model.texts_changed(&texts);
                self.model.drag(&texts, point);
            }
            self.dragging = !matches!(mouse.kind, MouseKind::Up(_));
            return true;
        }
        if !matches!(mouse.kind, MouseKind::Down(MouseButton::Left)) {
            return false;
        }
        let hit = area
            .contains(position)
            .then(|| {
                hits.iter().rev().find(|hit| {
                    hit.area.contains(position) && crate::keyboard::contains(tree, scope, hit.node)
                })
            })
            .flatten();
        let mut root = None;
        if let Some(hit) = hit {
            let mut node = Some(hit.node);
            let mut excluded = false;
            while let Some(id) = node {
                let Some(view) = tree.get(id) else {
                    break;
                };
                if id == hit.node {
                    excluded = view
                        .text_content
                        .as_ref()
                        .is_some_and(|text| text.selectable == Some(false));
                    if view
                        .text_content
                        .as_ref()
                        .is_some_and(|text| text.is_selectable())
                    {
                        root = Some(id);
                    }
                }
                if view.props.selectable_view && !excluded {
                    root = Some(id);
                }
                node = if id == scope { None } else { view.parent };
            }
        }
        let Some(root) = root else {
            self.clear();
            return false;
        };
        if self.root != Some(root) {
            self.model.clear();
        }
        self.root = Some(root);
        let texts = Texts::new(tree, geometry, root);
        if texts.is_empty() {
            self.clear();
            return false;
        }
        self.model.texts_changed(&texts);
        self.model
            .press(&texts, point, clicks.max(1), mouse.modifiers.shift);
        self.dragging = true;
        self.start = point;
        self.point = point;
        self.cell = position;
        self.taking = hit.is_none_or(|hit| hit.target.is_none());
        self.taking
    }

    /// When a drag held past its scroll view's edge scrolls it next.
    pub(crate) fn deadline(&self) -> Option<Instant> {
        self.next
    }

    /// Scrolls the nearest scroll view around the selection that a held drag
    /// is past the edge of, by whole Cells: the terminal reports no motion
    /// while the pointer rests, so the surface keeps scrolling on its own
    /// until the drag ends, comes back inside or the view can go no further.
    /// At the surface's own edge, where the pointer can go no further, the
    /// edge row or column counts as past it. `geometry` is the last frame's.
    pub(crate) fn autoscroll(
        &mut self,
        tree: &mut Mounter,
        area: Rect,
        cells: CellSize,
        geometry: &[Geometry],
    ) {
        let Some(root) = self.root.filter(|_| self.dragging && self.taking) else {
            self.next = None;
            return;
        };
        let now = Instant::now();
        if self.next.is_some_and(|due| due > now) {
            return;
        }
        self.next = None;
        let past = |cell: u16, start: u16, end: u16, first: u16, last: u16| -> i32 {
            let (cell, start, end) = (i32::from(cell), i32::from(start), i32::from(end));
            if cell < start {
                cell - start
            } else if cell >= end {
                cell - end + 1
            } else if cell == start && start == i32::from(first) {
                -1
            } else if cell == end - 1 && end == i32::from(last) {
                1
            } else {
                0
            }
        };
        let mut id = Some(root);
        while let Some(node) = id {
            let Some(view) = tree.get(node) else {
                break;
            };
            id = view.parent;
            let Some(scroll) = &view.scroll else {
                continue;
            };
            let Some(visible) = geometry.iter().find(|g| g.id == node).map(|g| g.visible) else {
                continue;
            };
            if visible.is_empty() {
                continue;
            }
            let (steps, cell, to) = if scroll.horizontal {
                let steps = past(
                    self.cell.x,
                    visible.x,
                    visible.right(),
                    area.x,
                    area.right(),
                );
                (steps, cells.width(), scroll.x)
            } else {
                let steps = past(
                    self.cell.y,
                    visible.y,
                    visible.bottom(),
                    area.y,
                    area.bottom(),
                );
                (steps, cells.height(), scroll.y)
            };
            if steps == 0 {
                continue;
            }
            let to = to + cell * steps as f32;
            if crate::keyboard::move_scroll(tree, node, to) != Points::ZERO {
                self.follow = true;
                self.next = Some(now + AUTOSCROLL_INTERVAL);
                return;
            }
        }
    }

    pub(crate) fn key(
        &mut self,
        key: &str,
        modifiers: crate::Modifiers,
        tree: &Mounter,
        geometry: &[Geometry],
        clipboard: &dyn nsh_core::clipboard::ClipboardBackend,
    ) -> bool {
        let Some(root) = self.root else {
            return false;
        };
        if !crate::keyboard::contains(tree, crate::navigation::focus_scope(tree), root) {
            self.clear();
            return false;
        }
        let texts = Texts::new(tree, geometry, root);
        self.model.texts_changed(&texts);
        if key == "Escape" || (modifiers.ctrl && key == "g") {
            let had = !self.model.is_empty();
            self.clear();
            return had;
        }
        if ((modifiers.ctrl || modifiers.cmd) && key.eq_ignore_ascii_case("c"))
            || (modifiers.ctrl && key == "Insert")
            || (modifiers.alt && key == "w")
        {
            if self.model.is_empty() {
                return false;
            }
            // A selection of hidden characters only leaves the clipboard
            // as it is.
            let text = self.model.text(&texts);
            if !text.is_empty() {
                clipboard.set_text(Some(text));
            }
            return true;
        }
        if (modifiers.ctrl || modifiers.cmd) && key.eq_ignore_ascii_case("a") {
            self.model.select_all(&texts);
            return true;
        }
        // Any other key ends the selection and then acts as usual.
        self.clear();
        false
    }

    /// While an input without its own selection holds focus, a non-empty page
    /// selection still owns Copy and Escape; any other key clears it first so
    /// the focused input edits cleanly.
    pub(crate) fn key_while_editing(
        &mut self,
        key: &str,
        modifiers: crate::Modifiers,
        tree: &Mounter,
        geometry: &[Geometry],
        clipboard: &dyn nsh_core::clipboard::ClipboardBackend,
    ) -> bool {
        if self.root.is_none() || self.model.is_empty() {
            return false;
        }
        let copy_or_escape = key == "Escape"
            || (modifiers.ctrl && key == "g")
            || ((modifiers.ctrl || modifiers.cmd) && key.eq_ignore_ascii_case("c"))
            || (modifiers.ctrl && key == "Insert")
            || (modifiers.alt && key == "w");
        if copy_or_escape {
            return self.key(key, modifiers, tree, geometry, clipboard);
        }
        self.clear();
        false
    }

    pub(crate) fn draw(&mut self, scene: Scene<'_>, buffer: &mut Buffer) {
        let Scene {
            area,
            cells,
            hits,
            geometry,
            tree,
        } = scene;
        let Some(root) = self.root else {
            return;
        };
        if !crate::keyboard::contains(tree, crate::navigation::focus_scope(tree), root) {
            self.clear();
            return;
        }
        let texts = Texts::new(tree, geometry, root);
        self.model.texts_changed(&texts);
        if std::mem::take(&mut self.follow) {
            self.model.drag(&texts, self.point);
        }
        for (i, range) in self.model.ranges(&texts) {
            let origin = texts.frame(i).origin;
            let geometry = texts.geometry[i];
            for (bounds, glyph) in &texts.layout(i).glyphs {
                if glyph.start >= range.end || glyph.end <= range.start {
                    continue;
                }
                let rect = CellBounds::new(
                    Bounds::new(origin + bounds.origin, bounds.size),
                    cells,
                    area,
                )
                .clipped(geometry.visible.intersection(buffer.area));
                for y in rect.y..rect.bottom() {
                    for x in rect.x..rect.right() {
                        if hits
                            .iter()
                            .rev()
                            .find(|hit| hit.area.contains(Position::new(x, y)))
                            .is_some_and(|hit| hit.node == geometry.id)
                        {
                            buffer[(x, y)].set_style(
                                ratatui_core::style::Style::default()
                                    .add_modifier(Modifier::REVERSED),
                            );
                        }
                    }
                }
            }
        }
    }
}
